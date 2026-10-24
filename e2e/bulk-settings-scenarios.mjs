import assert from 'node:assert/strict';

const press = (page, key) => page.keyboard ? page.keyboard.press(key) : page.press(key);
const activate = page => page.bringToFront ? page.bringToFront() : page.front();
const focus = async (page, selector) => { await activate(page); return page.evaluate(selector => document.querySelector(selector).focus(), selector); };
const fill = (page, selector, value) => page.locator ? page.locator(selector).fill(value) : page.fill(selector, value);
async function poll(read, check, label) {
  const deadline = Date.now() + 15_000; let value;
  do { value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const message = (page, key) => page.evaluate(key => (typeof browser === 'undefined' ? chrome : browser).i18n.getMessage(key), key);
const view = page => page.evaluate(() => ({
  controls: Object.fromEntries(['importRules', 'clearAllRules', 'resetSettings'].map(id => {
    const el = document.getElementById(id); return [id, { disabled: el.disabled, busy: el.getAttribute('aria-busy'), unavailable: el.getAttribute('aria-disabled') }];
  })), clear: document.getElementById('clearRulesStatus').textContent,
  reset: document.getElementById('resetSettingsStatus').textContent,
  active: document.activeElement.id, draft: document.getElementById('search-input').value,
  total: document.getElementById('totalRules').textContent,
  clearCalls: window.__bdClearProbe?.calls ?? 0, clearCommitted: window.__bdClearProbe?.committed ?? false,
  resetWrites: window.__bdResetProbe?.resets ?? 0, settingsWrites: window.__bdResetProbe?.writes ?? 0, resetSaved: window.__bdResetProbe?.saved ?? false,
  documentTag: window.__bdBulkDocumentTag ?? null,
  basicOpen: !document.getElementById('basic-settings-panel').hidden,
  displayed: { mode: document.querySelector('input[name="securityMode"]:checked')?.value,
    notifications: document.getElementById('showNotifications').checked, debug: document.getElementById('enableDebug').checked,
    password: document.getElementById('enablePassword').checked, sound: document.getElementById('focusSessionSound').checked }
}));
async function verifyPassword(page) {
  await activate(page);
  await poll(() => page.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'native password dialog');
  await fill(page, '#passwordInput1', 'BD-bulk-password'); await press(page, 'Enter');
}
async function rulesPanel(page) {
  await focus(page, '[aria-controls="rules-management-panel"]'); await press(page, 'Enter');
}
async function attach(e, name, evidence) {
  if (e.result) e.result[name] = evidence;
  if (e.testInfo) await e.testInfo.attach(name, { contentType: 'application/json', body: JSON.stringify(evidence) });
}

export const bulkSettingsScenarios = [{
  id: '62',
  title: 'Clear All rejects an old confirmation after another window imports, then clears once and preserves later focus',
  async run(e) {
    const a = await e.openOptions();
    await e.importBackup(a, { rules: [{ blockURL: 'bulk-before.bd-e2e.test' }] });
    await poll(() => e.state(), s => s.rules.length === 1 && s.rules[0].blockURL === 'bulk-before.bd-e2e.test', 'initial rule saved');
    await poll(() => a.evaluate(() => document.getElementById('importRules').getAttribute('aria-busy')), s => s === 'false', 'initial import finished');
    await a.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const { PasswordUtils } = await import(api.runtime.getURL('pro/password.js'));
      const { settings } = await api.storage.sync.get('settings');
      await api.storage.sync.set({ settings: { ...settings, enablePassword: true,
        passwordHash: await PasswordUtils.hashPassword('BD-bulk-password') } });
      const { RulesClient } = await import(api.runtime.getURL('rules/rulesClient.js'));
      const original = RulesClient.prototype.clearRules;
      const probe = window.__bdClearProbe = { original, calls: 0, hold: false, committed: false, release: null };
      RulesClient.prototype.clearRules = async function(...args) {
        probe.calls++; const result = await original.apply(this, args);
        if (probe.hold) { probe.committed = true; await new Promise(resolve => { probe.release = resolve; }); }
        return result;
      };
    });
    try {
      await rulesPanel(a); await focus(a, '#clearAllRules'); await press(a, 'Enter');
      await poll(() => a.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'first Clear waits for password');
      const b = await e.openOptions(); await rulesPanel(b); await focus(b, '#importRules');
      await e.importBackup(b, { rules: [{ blockURL: 'bulk-new.bd-e2e.test' }] });
      await verifyPassword(b);
      const imported = await poll(() => e.state(), s => s.rules.length === 1 && s.rules[0].blockURL === 'bulk-new.bd-e2e.test', 'other window imported a new generation');
      await verifyPassword(a);
      const changedMessage = await message(a, 'clearruleschanged');
      const stale = await poll(() => view(a), s => s.clear === changedMessage && s.controls.clearAllRules.busy === 'false', 'stale Clear rejected');
      assert.equal(stale.clearCalls, 1); assert.equal(stale.active, 'clearAllRules');
      const preserved = await e.state();
      assert.deepEqual(preserved.rules, imported.rules); assert.equal(preserved.rulesGeneration, imported.rulesGeneration);
      assert.deepEqual(preserved.dnr, imported.dnr);

      await a.evaluate(() => { window.__bdClearProbe.hold = true; });
      await focus(a, '#clearAllRules'); await press(a, 'Enter'); await verifyPassword(a);
      const waiting = await poll(() => view(a), s => s.clearCommitted, 'native Clear committed before delayed UI reply');
      assert.equal(waiting.clearCalls, 2);
      for (const control of Object.values(waiting.controls)) { assert.equal(control.unavailable, 'true'); assert.equal(control.disabled, false); }
      await press(a, 'Enter'); // Focus returned to Clear; a repeated trusted Enter sends no second intent.
      await focus(a, '#resetSettings'); await press(a, 'Enter');
      await focus(a, '#importRules'); await press(a, 'Enter');
      assert.equal((await view(a)).clearCalls, 2);
      await focus(a, '#search-input'); await fill(a, '#search-input', 'clear-draft');
      await a.evaluate(() => window.__bdClearProbe.release());
      const success = await message(a, 'allrulescleared');
      const completed = await poll(() => view(a), s => s.clear === success && s.controls.clearAllRules.busy === 'false', 'Clear completed without stealing Search');
      assert.equal(completed.active, 'search-input'); assert.equal(completed.draft, 'clear-draft'); assert.equal(completed.total, '0');
      const cleared = await e.state(); assert.deepEqual(cleared.rules, []); assert.deepEqual(cleared.dnr, []);
      assert.equal(cleared.settings.enablePassword, true, 'blocked Reset did not remove password protection');
      assert.notEqual(cleared.rulesGeneration, imported.rulesGeneration);
      const allowed = await e.newPage('http://bulk-new.bd-e2e.test/cleared');
      await poll(() => allowed.evaluate(() => document.querySelector('h1')?.textContent), value => value === 'BD E2E fixture', 'cleared target navigates normally');
      await attach(e, 'bulkClear', { stale, waiting, completed,
        note: 'Native file import, password dialogs, confirmations, worker queue, storage and DNR. Only successful reply delivery is gated; no native API failure or screen-reader speech claim.' });
    } finally {
      await a.evaluate(async () => {
        const probe = window.__bdClearProbe; if (!probe) return;
        const api = typeof browser === 'undefined' ? chrome : browser;
        const { RulesClient } = await import(api.runtime.getURL('rules/rulesClient.js'));
        RulesClient.prototype.clearRules = probe.original; probe.release?.();
      });
    }
  }
}, {
  id: '63',
  title: 'Reset Settings writes defaults once without reloading, preserves later field choices and Search focus, and blocks conflicting actions',
  async run(e) {
    const page = await e.openOptions();
    await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      await api.storage.sync.set({ settings: { mode: 'strict', confirmBeforeDelete: true, showNotifications: false,
        enablePassword: false, passwordHash: null, debugMode: true, focusSessionSound: false } });
    });
    // Reload only to establish the non-default fixture, before the action under test.
    await page.goto(await page.evaluate(() => location.href));
    await poll(() => page.evaluate(() => document.querySelector('input[name="securityMode"]:checked')?.value), v => v === 'strict', 'initial settings reflected');
    await rulesPanel(page);
    await focus(page, '[aria-controls="basic-settings-panel"]'); await press(page, 'Enter');
    await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const original = api.storage.sync.set;
      const probe = window.__bdResetProbe = { original, writes: 0, resets: 0, saved: false, release: null };
      window.__bdBulkDocumentTag = 'same-options-document';
      api.storage.sync.set = async function(values, ...args) {
        probe.writes++; const result = await original.call(this, values, ...args);
        if (!probe.saved && values.settings?.mode === 'normal' && values.settings.showNotifications === true &&
            values.settings.confirmBeforeDelete === false && values.settings.debugMode === false && values.settings.focusSessionSound === true) {
          probe.resets++; probe.saved = true; await new Promise(resolve => { probe.release = resolve; });
        }
        return result;
      };
    });
    const before = await e.state();
    try {
      await focus(page, '#resetSettings'); await press(page, 'Enter');
      const waiting = await poll(() => view(page), s => s.resetSaved, 'native reset write committed before held acknowledgement');
      assert.equal(waiting.resetWrites, 1); assert.equal(waiting.controls.resetSettings.busy, 'true');
      assert.equal(waiting.displayed.mode, 'strict', 'display awaits accepted write completion');
      for (const control of Object.values(waiting.controls)) assert.equal(control.unavailable, 'true');
      await press(page, 'Enter'); await focus(page, '#clearAllRules'); await press(page, 'Enter');
      await focus(page, '#importRules'); await press(page, 'Enter');
      assert.equal((await view(page)).settingsWrites, 1, 'repeated and conflicting actions sent no additional writes');
      const savedDefaults = (await e.state()).settings;
      assert.deepEqual(savedDefaults, { mode: 'normal', confirmBeforeDelete: false, showNotifications: true,
        enablePassword: false, passwordHash: null, debugMode: false, focusSessionSound: true });
      // An explicit later field choice can equal the old displayed value.
      // Native Space twice records that choice while reset acknowledgement waits.
      await focus(page, '#showNotifications'); await press(page, 'Space'); await press(page, 'Space');
      assert.equal((await view(page)).displayed.notifications, false);
      await focus(page, '#search-input'); await fill(page, '#search-input', 'reset-draft');
      await page.evaluate(() => window.__bdResetProbe.release());
      const resetMessage = await message(page, 'resettodefaults');
      await poll(() => e.state(), s => s.settings.showNotifications === false, 'later setting choice saved after Reset');
      const completed = await poll(() => view(page), s => s.reset === resetMessage && s.controls.resetSettings.busy === 'false', 'saved defaults and later field choice displayed');
      assert.deepEqual(completed.displayed, { mode: 'normal', notifications: false, debug: false, password: false, sound: true });
      assert.equal(completed.resetWrites, 1); assert.equal(completed.basicOpen, true);
      assert.equal(completed.active, 'search-input'); assert.equal(completed.draft, 'reset-draft');
      await new Promise(resolve => setTimeout(resolve, 1600));
      const later = await view(page);
      assert.equal(later.documentTag, 'same-options-document', 'no delayed document reload');
      assert.equal(later.active, 'search-input'); assert.equal(later.draft, 'reset-draft'); assert.equal(later.basicOpen, true);
      assert.equal(later.reset, resetMessage);
      const state = await e.state();
      assert.deepEqual(state.settings, { ...savedDefaults, showNotifications: false });
      assert.equal(later.resetWrites, 1); assert.equal(later.settingsWrites, 3);
      assert.deepEqual(state.rules, before.rules); assert.deepEqual(state.credentials, before.credentials);
      assert.equal(state.rulesGeneration, before.rulesGeneration);
      await attach(e, 'bulkReset', { waiting, completed, later, savedDefaults,
        note: 'Native sync storage write and keyboard activation with delivery-only gate. Document identity, default controls, disclosures and later focus/draft verified. No cloud-sync completion or screen-reader speech claim.' });
    } finally {
      await page.evaluate(() => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        const probe = window.__bdResetProbe;
        if (probe) { api.storage.sync.set = probe.original; probe.release?.(); }
      });
    }
  }
}];
