import assert from 'node:assert/strict';

const press = (page, key) => page.keyboard ? page.keyboard.press(key) : page.press(key);
const focus = (page, selector) => page.evaluate(selector => document.querySelector(selector).focus(), selector);
async function poll(read, check, label) {
  const deadline = Date.now() + 15_000;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const snapshot = page => page.evaluate(() => {
  const button = document.getElementById('importRules'), status = document.getElementById('importStatus');
  return { busy: button.getAttribute('aria-busy'), disabled: button.disabled,
    ariaDisabled: button.getAttribute('aria-disabled'), active: document.activeElement.id,
    status: status.textContent, role: status.getAttribute('role'), live: status.getAttribute('aria-live'),
    atomic: status.getAttribute('aria-atomic'), described: button.getAttribute('aria-describedby'),
    selectedFile: Boolean(document.getElementById('importFileInput').value),
    fileName: document.getElementById('importFileInput').files[0]?.name || null,
    fileChanges: (window.__bdImportFileEvents || []).filter(event => event.type === 'change').length,
    draft: document.getElementById('search-input').value,
    reads: window.__bdImportRead?.reads ?? null, readStarted: window.__bdImportRead?.started ?? false,
    saved: window.__bdImportReply?.saved ?? false, calls: window.__bdImportCalls ?? 0 };
});
const text = (page, key, count) => page.evaluate(({ key, count }) => {
  const api = typeof browser === 'undefined' ? chrome : browser;
  return api.i18n.getMessage(key, count);
}, { key, count });
const holdRead = page => page.evaluate(() => {
  const original = File.prototype.text;
  const gate = window.__bdImportRead = { original, started: false, reads: 0, release: null };
  File.prototype.text = async function() {
    const content = await original.call(this); gate.reads++;
    if (!gate.started) { gate.started = true; await new Promise(resolve => { gate.release = resolve; }); }
    return content;
  };
});
const releaseRead = page => page.evaluate(() => {
  const gate = window.__bdImportRead;
  if (gate) { File.prototype.text = gate.original; gate.release?.(); }
});

export const importScenarios = [{
  id: '61',
  title: 'Backup import has persistent safe feedback, one replacement per selection and preserves later keyboard focus',
  async run(e) {
    const page = await e.openOptions();
    await focus(page, '[aria-controls="rules-management-panel"]'); await press(page, 'Enter');
    await focus(page, '#exportRules'); await press(page, 'Tab');
    assert.equal((await snapshot(page)).active, 'importRules', 'Tab reaches Import');
    const before = await e.state();
    await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const { RulesClient } = await import(api.runtime.getURL('rules/rulesClient.js'));
      const original = window.__bdImportOriginal = RulesClient.prototype.replaceAll;
      window.__bdImportCalls = 0;
      window.__bdImportFileEvents = [];
      const input = document.getElementById('importFileInput');
      for (const type of ['input', 'change', 'cancel']) {
        // Capture the actual selection before the production change handler
        // synchronously releases its File snapshot and clears the input.
        input.addEventListener(type, event => window.__bdImportFileEvents.push({
          type, trusted: event.isTrusted, names: [...input.files].map(file => file.name)
        }), { capture: true });
      }
      RulesClient.prototype.replaceAll = function(...args) {
        window.__bdImportCalls++; return original.apply(this, args);
      };
    });
    await e.importBackup(page, { rules: [{ blockURL: 12 }] }, { filename: 'invalid-backup.json' });
    const invalidMessage = await text(page, 'importinvalidbackup');
    const invalid = await poll(() => snapshot(page), s => s.status === invalidMessage && s.busy === 'false', 'safe invalid-backup feedback');
    assert.deepEqual((await e.state()).rules, before.rules, 'invalid import preserves saved rules');
    assert.deepEqual([invalid.role, invalid.live, invalid.atomic, invalid.described], ['status', 'polite', 'true', 'importStatus']);
    assert.equal(invalid.fileChanges, 1);
    assert.equal(invalid.active, 'importRules'); assert.equal(invalid.selectedFile, false);

    try {
      await holdRead(page);
      await e.importBackup(page, { rules: [{ blockURL: 'import-first.bd-e2e.test' }] }, { filename: 'first-backup.json' });
      const reading = await poll(() => snapshot(page), s => s.readStarted, 'real File.text result held');
      assert.equal(reading.fileChanges, 2);
      assert.equal(reading.ariaDisabled, 'true'); assert.equal(reading.busy, 'true'); assert.equal(reading.disabled, false);
      await press(page, 'Enter'); // Real keyboard reactivation must not open a second picker.
      await e.importBackup(page, { rules: [{ blockURL: 'import-ignored.bd-e2e.test' }] }, { filename: 'ignored-backup.json' });
      const ignored = await snapshot(page);
      assert.equal(ignored.fileChanges, 3, 'the conflicting selection really emitted change');
      assert.equal(ignored.reads, 1, 'duplicate selection is not read');
      await releaseRead(page);
      const success = await text(page, 'importedrules', '1');
      const imported = await poll(() => snapshot(page), s => s.status === success && s.busy === 'false', 'one accepted import finishes');
      const first = await e.state();
      assert.deepEqual(first.rules.map(rule => rule.blockURL), ['import-first.bd-e2e.test']);
      assert.notEqual(first.rulesGeneration, before.rulesGeneration, 'replacement changes the opaque generation');
      assert.equal(imported.calls, 1, 'exactly one replacement intent');
      assert.equal(imported.fileName, 'ignored-backup.json');
      assert.equal(imported.selectedFile, true, 'late completion did not clear a later selection');
      assert.equal(imported.active, 'importRules'); assert.equal(imported.ariaDisabled, 'false');

      await holdRead(page);
      await e.importBackup(page, { rules: [{ blockURL: 'import-later.bd-e2e.test' }] }, { filename: 'later-backup.json' });
      const laterRead = await poll(() => snapshot(page), s => s.readStarted, 'second file held before confirmation');
      assert.equal(laterRead.fileChanges, 4);
      await focus(page, '#search-input');
      if (page.locator) await page.locator('#search-input').fill('later-draft');
      else await page.fill('#search-input', 'later-draft');
      await releaseRead(page);
      const cancelledMessage = await text(page, 'importcancelled');
      const cancelled = await poll(() => snapshot(page), s => s.status === cancelledMessage && s.busy === 'false', 'later Search choice cancels before confirmation');
      assert.equal(cancelled.active, 'search-input'); assert.equal(cancelled.draft, 'later-draft');
      assert.equal((await e.state()).rulesGeneration, first.rulesGeneration, 'canceled read did not mutate');
      assert.equal(cancelled.calls, 1);
      assert.equal(cancelled.selectedFile, false, 'production released the accepted selection before retry');

      // Hold delivery only after a genuine native worker reply and saved state.
      await page.evaluate(async () => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        const { RulesClient } = await import(api.runtime.getURL('rules/rulesClient.js'));
        const original = RulesClient.prototype.replaceAll;
        const gate = window.__bdImportReply = { original, saved: false, release: null };
        RulesClient.prototype.replaceAll = async function(...args) {
          const result = await original.apply(this, args); gate.saved = true;
          await new Promise(resolve => { gate.release = resolve; }); return result;
        };
      });
      await focus(page, '#importRules');
      // Re-select the unchanged file: no rewrite, new path or synthetic change.
      await e.importBackup(page, undefined, { filename: 'later-backup.json', reuse: true });
      await poll(() => snapshot(page), s => s.saved, 'real worker committed before held UI reply');
      const saved = await e.state();
      assert.deepEqual(saved.rules.map(rule => rule.blockURL), ['import-later.bd-e2e.test']);
      assert.notEqual(saved.rulesGeneration, first.rulesGeneration);
      assert.equal((await snapshot(page)).calls, 2, 'explicit retry sent exactly one additional intent');
      await focus(page, '#search-input');
      if (page.locator) await page.locator('#search-input').fill('keep-this-draft');
      else await page.fill('#search-input', 'keep-this-draft');
      await page.evaluate(() => window.__bdImportReply.release());
      const completed = await poll(() => snapshot(page), s => s.status === success && s.busy === 'false', 'committed reply finishes without taking Search focus');
      assert.equal(completed.active, 'search-input'); assert.equal(completed.draft, 'keep-this-draft');
      assert.equal(completed.selectedFile, false);
      assert.equal(completed.fileChanges, 5, 'unchanged-file retry emitted a new native change');
      const fileEvents = await page.evaluate(() => window.__bdImportFileEvents);
      assert.deepEqual(fileEvents.filter(event => event.type === 'change').map(event => event.names), [
        ['invalid-backup.json'], ['first-backup.json'], ['ignored-backup.json'],
        ['later-backup.json'], ['later-backup.json']
      ]);
      await new Promise(resolve => setTimeout(resolve, 3200));
      const persistent = await snapshot(page);
      assert.equal(persistent.status, success, 'result remains after the old toast expiry');
      assert.equal(persistent.active, 'search-input'); assert.equal(persistent.draft, 'keep-this-draft');
      const evidence = { invalid, reading, ignored, imported, laterRead, cancelled, completed, persistent, fileEvents,
        note: 'Native extension storage, worker replacement, File reads, file-input upload and keyboard activation. Delivery gates preserve real results. OS picker cancellation, injected worker failures, screen-reader speech and Android are separate checks.' };
      if (e.result) e.result.backupImport = evidence;
      if (e.testInfo) await e.testInfo.attach('backup-import', { contentType: 'application/json', body: JSON.stringify(evidence) });
    } finally {
      await releaseRead(page);
      await page.evaluate(async () => {
        const gate = window.__bdImportReply;

        const api = typeof browser === 'undefined' ? chrome : browser;
        const { RulesClient } = await import(api.runtime.getURL('rules/rulesClient.js'));
        if (gate) { RulesClient.prototype.replaceAll = gate.original; gate.release?.(); }
        if (window.__bdImportOriginal) RulesClient.prototype.replaceAll = window.__bdImportOriginal;
      });
    }
  }
}];
