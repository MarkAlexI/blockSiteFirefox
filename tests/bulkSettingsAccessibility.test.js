import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const defaults = { mode: 'normal', confirmBeforeDelete: false, showNotifications: true,
  enablePassword: false, passwordHash: null, debugMode: false, focusSessionSound: true };
const initial = { ...defaults, mode: 'strict', confirmBeforeDelete: true, showNotifications: false, debugMode: true, focusSessionSound: false };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const backup = { name: 'backup.json', text: async () => '{"rules":[]}' };
const statusId = method => method === 'clearAllRules' ? 'clearRulesStatus' : 'resetSettingsStatus';

async function withBulk(t, run) {
  const document = new FakeDocument();
  for (const id of ['clearAllRules', 'resetSettings', 'importRules', 'exportRules']) {
    const el = document.addElement(id, 'button');
    el.closest = () => {
      for (let node = el; node; node = node.parentNode) {
        if (node.hidden || node.getAttribute('inert') !== null || node.classList.contains('hidden') || node.classList.contains('focus-lock-active')) return node;
      }
      return null;
    };
  }
  for (const id of ['clearRulesStatus', 'resetSettingsStatus', 'importStatus', 'statusMessage', 'totalRules']) document.addElement(id);
  const input = document.addElement('importFileInput', 'input');
  const search = document.addElement('search-input', 'input');
  for (const id of ['confirmBeforeDelete', 'showNotifications', 'enablePassword', 'enableDebug', 'focusSessionSound']) {
    const el = document.addElement(id, 'input'); el.type = 'checkbox';
  }
  for (const value of ['normal', 'strict']) {
    const el = document.addElement('mode-' + value, 'input'); el.type = 'radio'; el.name = 'securityMode'; el.value = value;
  }
  const api = createExtensionApi({ sync: { credentials: { isPro: true }, settings: initial },
    local: { rules: [{ id: 1, blockURL: 'saved.example' }], rulesGeneration: 'shown-generation' } });
  const prompts = [], clears = [], imports = [], timers = [];
  let accepted = true, reloads = 0;
  const oldConfirm = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  globalThis.confirm = message => { prompts.push(message); return accepted; };
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { timers.push({ fn, delay }); return timers.length; });
  try {
    await withExtensionEnvironment(api, async () => {
      const { SettingsManager } = await import('../options/settings.js');
      const { ProManager } = await import('../pro/proManager.js');
      const { PasswordUtils } = await import('../pro/password.js');
      const manager = Object.create(SettingsManager.prototype);
      manager.logger = { log() {}, info() {}, error() {} };
      manager.defaultSettings = { ...defaults };
      manager.loadStatistics = async () => true;
      manager.rulesClient = {
        async clearRules(generation) { clears.push(generation); api.storage.local.data.rules = []; return { rules: [] }; },
        async replaceAll(value) { imports.push(value); return { rules: value.rules }; }
      };
      manager.applySettingsToUI(initial);
      await run({ manager, document, search, input, api, prompts, clears, imports, timers, SettingsManager, ProManager, PasswordUtils,
        confirm: value => { accepted = value; }, reloads: () => reloads });
    }, { document, window: { location: { reload() { reloads++; } } } });
  } finally {
    if (oldConfirm) Object.defineProperty(globalThis, 'confirm', oldConfirm);
    else delete globalThis.confirm;
  }
}

for (const [id, status] of [['clearAllRules', 'clearRulesStatus'], ['resetSettings', 'resetSettingsStatus']]) {
  test(`${id} describes its persistent polite atomic feedback and remains a native button`, async () => {
    const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
    assert.match(html, new RegExp(`<button id="${id}"[^>]*type="button"[^>]*aria-describedby="${status}"[^>]*aria-disabled="false"[^>]*aria-busy="false"`));
    assert.match(html, new RegExp(`id="${status}"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*><\\/p>`));
  });
}

for (const method of ['clearAllRules', 'resetSettings']) {
  test(`${method} rejects duplicate and conflicting actions before a delayed Pro check`, async t => {
    await withBulk(t, async ({ manager, document, ProManager, input, clears, imports, prompts }) => {
      const gate = deferred(); let checks = 0, opened = 0;
      t.mock.method(ProManager, 'hasPaidAccess', () => { checks++; return gate.promise; });
      input.click = () => { opened++; };
      const button = document.getElementById(method); button.focus();
      const first = manager[method]();
      for (const id of ['importRules', 'clearAllRules', 'resetSettings']) {
        assert.equal(document.getElementById(id).getAttribute('aria-disabled'), 'true');
        assert.equal(document.getElementById(id).disabled, false);
      }
      assert.equal(button.getAttribute('aria-busy'), 'true');
      await manager.clearAllRules(); await manager.resetSettings(); await manager.chooseImportFile(); await manager.importRules(backup);
      assert.equal(checks, 1); assert.equal(prompts.length + clears.length + imports.length + opened, 0);
      gate.resolve(true); await first;
      for (const id of ['importRules', 'clearAllRules', 'resetSettings']) assert.equal(document.getElementById(id).getAttribute('aria-disabled'), 'false');
      assert.equal(document.activeElement, button);
    });
  });

  for (const stage of ['denied', 'access error', 'protected settings error', 'password cancelled', 'confirmation cancelled']) {
    test(`${method}: ${stage} has safe feedback and never mutates`, async t => {
      await withBulk(t, async ({ manager, api, document, ProManager, SettingsManager, PasswordUtils, clears, imports, prompts, confirm }) => {
        const before = structuredClone(api.storage.sync.data.settings);
        if (stage === 'denied') t.mock.method(ProManager, 'hasPaidAccess', async () => false);
        if (stage === 'access error') t.mock.method(ProManager, 'hasPaidAccess', async () => { throw new Error('private credentials'); });
        if (stage === 'protected settings error') t.mock.method(SettingsManager, 'getSettings', async () => { throw new Error('private settings'); });
        if (stage === 'password cancelled') {
          api.storage.sync.data.settings.enablePassword = before.enablePassword = true;
          t.mock.method(PasswordUtils, 'showPasswordModal', (_mode, callback) => callback(false));
        }
        if (stage === 'confirmation cancelled') confirm(false);
        document.getElementById(method).focus(); await manager[method]();
        const expected = stage === 'denied' ? 'prorequired' : stage.endsWith('cancelled') ? 'settingsactioncancelled' : method === 'clearAllRules' ? 'errorclearingrules' : 'errorresettingsettings';
        assert.equal(document.getElementById(statusId(method)).textContent, expected);
        assert.equal(clears.length + imports.length, 0);
        assert.deepEqual(api.storage.sync.data.settings, before);
        assert.equal(api.storage.local.data.rules.length, 1);
        assert.equal(document.getElementById(method).getAttribute('aria-busy'), 'false');
        assert.equal(prompts.length, stage === 'confirmation cancelled' ? 1 : 0);
      });
    });
  }

  test(`${method} keeps the shared guard throughout password verification`, async t => {
    await withBulk(t, async ({ manager, api, document, PasswordUtils, clears, imports, prompts }) => {
      api.storage.sync.data.settings.enablePassword = true;
      let settle, count = 0;
      t.mock.method(PasswordUtils, 'showPasswordModal', (_mode, callback) => { count++; settle = callback; });
      document.getElementById(method).focus();
      const first = manager[method](); await tick(); assert.equal(count, 1);
      await manager.clearAllRules(); await manager.resetSettings(); await manager.importRules(backup);
      assert.equal(count, 1); assert.equal(clears.length + imports.length + prompts.length, 0);
      settle(true); await first;
      assert.equal(prompts.length, 1);
    });
  });

  for (const boundary of ['Search choice', 'hidden page', 'unfocused page', 'hidden opener', 'inert ancestor', 'Focus lock', 'another dialog', 'detached opener']) {
    test(`${method} cancels a delayed prompt after ${boundary}`, async t => {
      await withBulk(t, async ({ manager, document, ProManager, search, prompts, clears }) => {
        const gate = deferred(); t.mock.method(ProManager, 'hasPaidAccess', () => gate.promise);
        const button = document.getElementById(method); button.focus();
        const first = manager[method]();
        if (boundary === 'Search choice') { search.value = 'later-draft'; search.focus(); }
        if (boundary === 'hidden page') document.visibilityState = 'hidden';
        if (boundary === 'unfocused page') document.hasFocus = () => false;
        if (boundary === 'hidden opener') button.hidden = true;
        if (boundary === 'inert ancestor') button.parentNode.setAttribute('inert', '');
        if (boundary === 'Focus lock') button.classList.add('focus-lock-active');
        if (boundary === 'another dialog') document.addElement('other-dialog', 'dialog').setAttribute('open', '');
        if (boundary === 'detached opener') button.isConnected = false;
        gate.resolve(true); await first;
        assert.equal(document.getElementById(statusId(method)).textContent, 'settingsactioncancelled');
        assert.equal(prompts.length + clears.length, 0);
        assert.deepEqual(document.activeElement, boundary === 'Search choice' ? search : button);
      });
    });
  }

  test(`${method} does not schedule status expiry or reload and leaves the result independent of generic feedback`, async t => {
    await withBulk(t, async ({ manager, document, timers, reloads }) => {
      document.getElementById(method).focus(); await manager[method]();
      assert.equal(timers.length, 0); assert.equal(reloads(), 0);
      const result = document.getElementById(statusId(method)).textContent;
      assert.equal(result, method === 'clearAllRules' ? 'allrulescleared' : 'resettodefaults');
      manager.showStatus('unrelated'); timers.at(-1).fn();
      assert.equal(document.getElementById(statusId(method)).textContent, result);
    });
  });

  test(`${method} releases the guard after a failed write and accepts an explicit retry`, async t => {
    await withBulk(t, async ({ manager, document, api, clears }) => {
      let writes = 0;
      if (method === 'clearAllRules') manager.rulesClient.clearRules = async value => {
        if (++writes === 1) throw new Error('private worker failure');
        clears.push(value); api.storage.local.data.rules = []; return { rules: [] };
      };
      else {
        const nativeSet = api.storage.sync.set.bind(api.storage.sync);
        t.mock.method(api.storage.sync, 'set', async values => {
          if (++writes === 1) throw new Error('private sync failure');
          return nativeSet(values);
        });
      }
      document.getElementById(method).focus(); await manager[method]();
      assert.equal(document.getElementById(statusId(method)).textContent, method === 'clearAllRules' ? 'errorclearingrules' : 'errorresettingsettings');
      await manager[method]();
      assert.equal(writes, 2);
      assert.equal(document.getElementById(statusId(method)).textContent, method === 'clearAllRules' ? 'allrulescleared' : 'resettodefaults');
    });
  });
}

for (const method of ['chooseImportFile', 'importRules']) {
  test(`an active ${method} also blocks Clear and Reset without changing the import feedback`, async t => {
    await withBulk(t, async ({ manager, document, ProManager, clears, prompts }) => {
      const gate = deferred(); t.mock.method(ProManager, 'hasPaidAccess', () => gate.promise);
      document.getElementById('importRules').focus();
      const first = manager[method](backup);
      const status = document.getElementById('importStatus').textContent;
      await manager.clearAllRules(); await manager.resetSettings();
      assert.equal(document.getElementById('importStatus').textContent, status);
      assert.equal(document.getElementById('clearRulesStatus').textContent, '');
      assert.equal(document.getElementById('resetSettingsStatus').textContent, '');
      assert.equal(clears.length + prompts.length, 0);
      document.getElementById('importFileInput').click = () => {};
      gate.resolve(true); await first;
    });
  });
}

for (const flags of [{ syncPending: true }, { dailyUsageSyncPending: true }, { syncPending: true, dailyUsageSyncPending: true }]) {
  test(`Clear preserves a committed empty state with ${JSON.stringify(flags)} and sends no retry`, async t => {
    await withBulk(t, async ({ manager, document, api, clears }) => {
      manager.rulesClient.clearRules = async value => {
        clears.push(value); api.storage.local.data.rules = []; return { rules: [], ...flags };
      };
      document.getElementById('clearAllRules').focus(); await manager.clearAllRules();
      assert.deepEqual(clears, ['shown-generation']);
      assert.deepEqual(api.storage.local.data.rules, []);
      assert.equal(document.getElementById('totalRules').textContent, 0);
      const status = document.getElementById('clearRulesStatus');
      assert.equal(status.textContent, 'ruleschangessavedpending'); assert.equal(status.classList.contains('error'), true);
    });
  });
}

for (const failure of ['read', 'malformed']) {
  test(`Clear handles ${failure} failure without confirmation or replacement`, async t => {
    await withBulk(t, async ({ manager, api, document, prompts, clears }) => {
      if (failure === 'read') api.storage.local.getError = new Error('private local data');
      else api.storage.local.data.rules = { length: 4 };
      document.getElementById('clearAllRules').focus(); await manager.clearAllRules();
      assert.equal(document.getElementById('clearRulesStatus').textContent, 'errorclearingrules');
      assert.equal(prompts.length + clears.length, 0);
    });
  });
}

test('an empty Clear result releases the shared guard without opening a password prompt', async t => {
  await withBulk(t, async ({ manager, api, document, PasswordUtils, prompts, clears }) => {
    api.storage.local.data.rules = []; api.storage.sync.data.settings.enablePassword = true;
    t.mock.method(PasswordUtils, 'showPasswordModal', () => assert.fail('empty clear opened a password dialog'));
    document.getElementById('clearAllRules').focus(); await manager.clearAllRules();
    assert.equal(document.getElementById('clearRulesStatus').textContent, 'norulestoclear');
    assert.equal(prompts.length + clears.length, 0);
    assert.equal(document.getElementById('resetSettings').getAttribute('aria-disabled'), 'false');
  });
});

test('a stale Clear has dedicated localized feedback and never applies the rejected state', async t => {
  await withBulk(t, async ({ manager, document, api }) => {
    manager.rulesClient.clearRules = async generation => {
      assert.equal(generation, 'shown-generation');
      throw Object.assign(new Error('private changed rules'), { code: 'rules_state_changed' });
    };
    document.getElementById('clearAllRules').focus(); await manager.clearAllRules();
    assert.equal(document.getElementById('clearRulesStatus').textContent, 'clearruleschanged');
    assert.equal(api.storage.local.data.rules.length, 1);
  });
});

for (const method of ['clearAllRules', 'resetSettings']) {
  for (const reject of [false, true]) {
    test(`${method} preserves a later Search draft and focus after its write (failure=${reject})`, async t => {
      await withBulk(t, async ({ manager, document, search, api, clears, imports, timers }) => {
        const gate = deferred(); let started = false;
        if (method === 'clearAllRules') manager.rulesClient.clearRules = value => { clears.push(value); started = true; return gate.promise; };
        else t.mock.method(api.storage.sync, 'set', () => { started = true; return gate.promise; });
        document.getElementById(method).focus(); const first = manager[method](); await tick(); assert.equal(started, true);
        await manager.clearAllRules(); await manager.resetSettings(); await manager.importRules(backup);
        assert.equal(imports.length, 0);
        search.value = 'keep-draft'; search.focus();
        if (reject) gate.reject(new Error('private delayed failure'));
        else { if (method === 'clearAllRules') api.storage.local.data.rules = []; gate.resolve({ rules: [] }); }
        await first;
        assert.equal(document.activeElement, search); assert.equal(search.value, 'keep-draft');
        assert.equal(search.focusCount, 1); assert.equal(timers.length, 0);
        assert.equal(document.getElementById(method).getAttribute('aria-busy'), 'false');
      });
    });
  }
}

test('Reset displays only defaults whose write succeeded and leaves all other storage intact', async t => {
  await withBulk(t, async ({ manager, api, document }) => {
    const local = structuredClone(api.storage.local.data), credentials = structuredClone(api.storage.sync.data.credentials);
    document.getElementById('resetSettings').focus();
    api.storage.sync.setError = new Error('quota'); await manager.resetSettings();
    assert.equal(document.getElementById('mode-strict').checked, true);
    assert.deepEqual(api.storage.sync.data.settings, initial);
    api.storage.sync.setError = null; await manager.resetSettings();
    assert.deepEqual(api.storage.sync.data.settings, defaults);
    assert.equal(document.getElementById('mode-normal').checked, true);
    assert.equal(document.getElementById('showNotifications').checked, true);
    assert.equal(document.getElementById('enableDebug').checked, false);
    assert.equal(document.getElementById('focusSessionSound').checked, true);
    assert.deepEqual(api.storage.local.data, local); assert.deepEqual(api.storage.sync.data.credentials, credentials);
  });
});

for (const pending of [false, true]) {
  test(`a failed post-clear refresh keeps the saved outcome (syncPending=${pending})`, async t => {
    await withBulk(t, async ({ manager, document, api, clears }) => {
      manager.rulesClient.clearRules = async value => {
        clears.push(value); api.storage.local.data.rules = []; api.storage.local.getError = new Error('private count read');
        return { rules: [], syncPending: pending };
      };
      document.getElementById('clearAllRules').focus(); await manager.clearAllRules();
      assert.equal(document.getElementById('clearRulesStatus').textContent, `${pending ? 'ruleschangessavedpending' : 'allrulescleared'} importrefreshfailed`);
      assert.equal(clears.length, 1); assert.deepEqual(api.storage.local.data.rules, []);
    });
  });
}

test('a post-reset UI exception cannot turn the saved defaults into an apparent write failure', async t => {
  await withBulk(t, async ({ manager, document, api }) => {
    manager.applySettingsToUI = () => { throw new Error('private render failure'); };
    document.getElementById('resetSettings').focus(); await manager.resetSettings();
    assert.deepEqual(api.storage.sync.data.settings, defaults);
    assert.equal(document.getElementById('resetSettingsStatus').textContent, 'resettodefaults importrefreshfailed');
  });
});

test('rule-count refresh ignores an obsolete read and its late error after a newer view wins', async t => {
  await withBulk(t, async ({ manager, document, api }) => {
    const old = deferred(); t.mock.method(api.storage.local, 'get', () => old.promise);
    const first = manager.loadRuleCount(null, { throwOnError: true });
    await manager.loadRuleCount([]); old.resolve({ rules: [{ id: 1 }] }); await first;
    assert.equal(document.getElementById('totalRules').textContent, 0);
    const failure = deferred(); t.mock.method(api.storage.local, 'get', () => failure.promise);
    const second = manager.loadRuleCount(null, { throwOnError: true });
    await manager.loadRuleCount([{ id: 2 }, { id: 3 }]); failure.reject(new Error('obsolete count error')); await second;
    assert.equal(document.getElementById('totalRules').textContent, 2);
  });
});

test('Reset preserves a later setting choice made while the reset acknowledgement is delayed', async t => {
  await withBulk(t, async ({ manager, document, api }) => {
    const gate = deferred(), started = deferred(), nativeSet = api.storage.sync.set.bind(api.storage.sync);
    let held = false;
    t.mock.method(api.storage.sync, 'set', async values => {
      const result = await nativeSet(values);
      if (!held && values.settings.mode === 'normal') { held = true; started.resolve(); await gate.promise; }
      return result;
    });
    document.getElementById('resetSettings').focus(); const reset = manager.resetSettings(); await started.promise;
    document.getElementById('enableDebug').checked = true;
    const later = manager.saveSettings({ debugMode: true }); await tick();
    gate.resolve(); await Promise.all([reset, later]);
    assert.equal(api.storage.sync.data.settings.debugMode, true);
    assert.equal(api.storage.sync.data.settings.mode, 'normal');
    assert.equal(document.getElementById('enableDebug').checked, true, 'late defaults cannot replace the later choice');
  });
});

test('two later setting saves wait for Reset and merge without restoring the previous security mode', async t => {
  await withBulk(t, async ({ manager, document, api }) => {
    const gate = deferred(), started = deferred(), nativeSet = api.storage.sync.set.bind(api.storage.sync);
    let held = false;
    t.mock.method(api.storage.sync, 'set', async values => {
      const result = await nativeSet(values);
      if (!held && values.settings.mode === 'normal') { held = true; started.resolve(); await gate.promise; }
      return result;
    });
    document.getElementById('resetSettings').focus(); const reset = manager.resetSettings(); await started.promise;
    document.getElementById('showNotifications').checked = false;
    const notifications = manager.saveSettings({ showNotifications: false });
    document.getElementById('focusSessionSound').checked = false;
    const sound = manager.saveSettings({ focusSessionSound: false });
    await tick(); gate.resolve(); await Promise.all([reset, notifications, sound]);
    assert.deepEqual(api.storage.sync.data.settings, { ...defaults, showNotifications: false, focusSessionSound: false });
    assert.equal(document.getElementById('showNotifications').checked, false);
    assert.equal(document.getElementById('focusSessionSound').checked, false);
  });
});

test('a setting save begun before Reset finishes first so it cannot restore old settings afterward', async t => {
  await withBulk(t, async ({ manager, document, api }) => {
    const gate = deferred(), started = deferred(), nativeSet = api.storage.sync.set.bind(api.storage.sync);
    let held = false;
    t.mock.method(api.storage.sync, 'set', async values => {
      if (!held && values.settings.mode === 'strict') { held = true; started.resolve(); await gate.promise; }
      return nativeSet(values);
    });
    const earlier = manager.saveSettings({ showNotifications: true }); await started.promise;
    document.getElementById('resetSettings').focus(); const reset = manager.resetSettings(); await tick();
    gate.resolve(); await Promise.all([earlier, reset]);
    assert.deepEqual(api.storage.sync.data.settings, defaults);
    assert.equal(document.getElementById('mode-normal').checked, true);
  });
});

test('a failed Reset releases later setting saves without replacing the previous settings', async t => {
  await withBulk(t, async ({ manager, document, api }) => {
    const gate = deferred(), started = deferred(), nativeSet = api.storage.sync.set.bind(api.storage.sync);
    t.mock.method(api.storage.sync, 'set', async values => {
      if (values.settings.mode === 'normal') { started.resolve(); await gate.promise; throw new Error('reset unavailable'); }
      return nativeSet(values);
    });
    document.getElementById('resetSettings').focus(); const reset = manager.resetSettings(); await started.promise;
    document.getElementById('showNotifications').checked = true;
    const later = manager.saveSettings({ showNotifications: true }); await tick(); gate.resolve();
    await Promise.all([reset, later]);
    assert.deepEqual(api.storage.sync.data.settings, { ...initial, showNotifications: true });
    assert.equal(document.getElementById('mode-strict').checked, true);
    assert.equal(document.getElementById('resetSettingsStatus').textContent, 'errorresettingsettings');
  });
});

test('ordinary simultaneous partial settings saves merge their fields in request order', async t => {
  await withBulk(t, async ({ manager, api }) => {
    await Promise.all([manager.saveSettings({ showNotifications: true }), manager.saveSettings({ focusSessionSound: true })]);
    assert.deepEqual(api.storage.sync.data.settings, { ...initial, showNotifications: true, focusSessionSound: true });
  });
});
