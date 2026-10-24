import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_BACKUP_FILE_BYTES } from '../backup/backupFormat.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const file = (text = '{"rules":[{"blockURL":"backup.example"}]}', options = {}) =>
  ({ name: 'backup.json', async text() { return text; }, ...options });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function withImport(t, run) {
  const document = new FakeDocument();
  const button = document.addElement('importRules', 'button');
  button.closest = () => {
    for (let node = button; node; node = node.parentNode) {
      if (node.hidden || node.getAttribute('inert') !== null ||
          node.classList.contains('hidden') || node.classList.contains('focus-lock-active')) return node;
    }
    return null;
  };
  const input = document.addElement('importFileInput', 'input');
  const status = document.addElement('importStatus', 'p');
  const search = document.addElement('search-input', 'input');
  document.addElement('statusMessage');
  for (const id of ['exportRules', 'clearAllRules', 'resetSettings']) document.addElement(id, 'button');
  const api = createExtensionApi({ sync: { credentials: { isPro: true }, settings: { enablePassword: false } } });
  const prompts = [], replacements = [];
  let accepted = true;
  t.mock.method(globalThis, 'setTimeout', () => 1);
  const oldConfirm = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  globalThis.confirm = message => { prompts.push(message); return accepted; };
  try {
    await withExtensionEnvironment(api, async () => {
      const { SettingsManager } = await import('../options/settings.js');
      const { ProManager } = await import('../pro/proManager.js');
      const { PasswordUtils } = await import('../pro/password.js');
      const manager = Object.create(SettingsManager.prototype);
      manager.logger = { log() {}, error() {} };
      manager.applySettingsToUI = () => {};
      manager.loadRuleCount = async () => {};
      manager.loadStatistics = async () => true;
      manager.rulesClient = { async replaceAll(backup) { replacements.push(backup); return { rules: backup.rules }; } };
      button.focus();
      await run({ manager, document, button, input, status, search, api, prompts, replacements,
        ProManager, PasswordUtils, SettingsManager, confirm: value => { accepted = value; } });
    }, { document });
  } finally {
    if (oldConfirm) Object.defineProperty(globalThis, 'confirm', oldConfirm);
    else delete globalThis.confirm;
  }
}

test('import feedback is a persistent polite atomic region described by its keyboard-focusable button', async () => {
  const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
  assert.match(html, /id="importStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*><\/p>/);
  assert.match(html, /<button id="importRules"[^>]*type="button"[^>]*aria-describedby="importStatus"[^>]*aria-disabled="false"[^>]*aria-busy="false"/);
});

test('chooser guard is acquired before access checks and blocks a second chooser or selection', async t => {
  await withImport(t, async ({ manager, button, input, ProManager, replacements }) => {
    const gate = deferred(); let checks = 0, opened = 0;
    t.mock.method(ProManager, 'hasPaidAccess', () => { checks++; return gate.promise; });
    input.click = () => { opened++; };
    const choosing = manager.chooseImportFile();
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.disabled, false);
    assert.equal(await manager.chooseImportFile(), false);
    await manager.importRules(file());
    assert.equal(checks, 1);
    gate.resolve(true); await choosing;
    assert.equal(opened, 1); assert.equal(replacements.length, 0);
    assert.equal(button.getAttribute('aria-busy'), 'false');
  });
});

test('picker cancellation cannot leave a lock and choosing the same file clears the previous selection', async t => {
  await withImport(t, async ({ manager, button, input, status }) => {
    let opened = 0; input.click = () => { opened++; assert.equal(input.value, ''); };
    status.textContent = 'previous import result';
    for (let i = 0; i < 2; i++) {
      input.value = 'same-backup.json';
      assert.equal(await manager.chooseImportFile(), true);
      // No cancel/change event is required to release the launch guard.
      assert.equal(button.getAttribute('aria-disabled'), 'false');
    }
    assert.equal(opened, 2); assert.equal(status.textContent, 'previous import result');
  });
});

test('picker launch failure is safe and explicitly retryable', async t => {
  await withImport(t, async ({ manager, input, status, button }) => {
    input.click = () => { throw new Error('private /home/profile/backup.json'); };
    assert.equal(await manager.chooseImportFile(), false);
    assert.equal(status.textContent, 'importfailed');
    assert.equal(button.getAttribute('aria-busy'), 'false');
    input.click = () => {};
    assert.equal(await manager.chooseImportFile(), true);
  });
});

for (const entry of ['chooseImportFile', 'importRules']) {
  test(`${entry} denies Free access without a picker, password prompt or mutation`, async t => {
    await withImport(t, async ({ manager, input, status, button, api, replacements, prompts }) => {
      api.storage.sync.data.credentials = { isPro: false, installationDate: '2026-08-01T00:00:00Z' };
      let reads = 0, opened = 0;
      input.click = () => { opened++; };
      assert.equal(await manager[entry](file('', { text() { reads++; return ''; } })), false);
      assert.equal(status.textContent, 'prorequired');
      assert.equal(reads + opened + prompts.length + replacements.length, 0);
      assert.equal(button.getAttribute('aria-disabled'), 'false');
    });
  });
}

test('selection guard also covers a delayed access check before reading any bytes', async t => {
  await withImport(t, async ({ manager, ProManager, button, status, replacements }) => {
    const gate = deferred(); let reads = 0, checks = 0;
    t.mock.method(ProManager, 'hasPaidAccess', () => { checks++; return gate.promise; });
    const importing = manager.importRules(file(undefined, { async text() { reads++; return '{"rules":[]}'; } }));
    assert.equal(status.textContent, 'importinprogress');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    await manager.importRules(file());
    gate.resolve(true); await importing;
    assert.equal(checks, 1); assert.equal(reads, 1); assert.equal(replacements.length, 1);
  });
});

test('a delayed file read cannot start a parallel replacement or clear a later input selection', async t => {
  await withImport(t, async ({ manager, input, button, status, replacements, prompts }) => {
    const read = deferred(); let ignoredReads = 0;
    input.value = 'original.json';
    const first = manager.importRules(file('', { text: () => read.promise }));
    assert.equal(input.value, ''); await tick();
    input.value = 'later.json';
    await manager.importRules(file('', { text() { ignoredReads++; } }));
    assert.equal(await manager.chooseImportFile(), false);
    read.resolve('{"rules":[{"blockURL":"original.example"}]}');
    assert.equal(await first, true);
    assert.equal(replacements.length, 1); assert.equal(replacements[0].rules[0].blockURL, 'original.example');
    assert.equal(prompts.length, 1); assert.equal(ignoredReads, 0);
    assert.equal(input.value, 'later.json');
    assert.equal(status.textContent, 'importedrules:1');
    assert.equal(button.getAttribute('aria-disabled'), 'false');
  });
});

test('a pending password prompt has only one owner and cancellation releases the import', async t => {
  await withImport(t, async ({ manager, PasswordUtils, api, status, replacements, prompts, button }) => {
    api.storage.sync.data.settings.enablePassword = true;
    let settle, opened = 0;
    t.mock.method(PasswordUtils, 'showPasswordModal', (_mode, callback) => { opened++; settle = callback; });
    const first = manager.importRules(file()); await tick();
    assert.equal(opened, 1);
    await manager.importRules(file());
    assert.equal(await manager.chooseImportFile(), false);
    settle(false); assert.equal(await first, false);
    assert.equal(status.textContent, 'importcancelled');
    assert.equal(prompts.length + replacements.length, 0);
    assert.equal(button.getAttribute('aria-busy'), 'false');
  });
});

test('a canceled native confirmation preserves rules and permits a same-file retry', async t => {
  await withImport(t, async ({ manager, confirm, status, replacements, button }) => {
    const backup = file(); confirm(false);
    await manager.importRules(backup);
    assert.equal(status.textContent, 'importcancelled'); assert.equal(replacements.length, 0);
    assert.equal(button.getAttribute('aria-disabled'), 'false');
    confirm(true); await manager.importRules(backup);
    assert.equal(replacements.length, 1);
  });
});

test('the guard lasts through worker reply and UI refresh while the focused button remains usable by keyboard', async t => {
  await withImport(t, async ({ manager, document, button, replacements, prompts, status }) => {
    const worker = deferred(), refresh = deferred();
    manager.rulesClient.replaceAll = async backup => { replacements.push(backup); return worker.promise; };
    manager.loadRuleCount = () => refresh.promise;
    const first = manager.importRules(file()); await tick();
    assert.equal(replacements.length, 1);
    await manager.importRules(file());
    assert.equal(document.activeElement, button);
    worker.resolve({ rules: [] }); await tick();
    assert.equal(await manager.chooseImportFile(), false);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(status.textContent, 'importinprogress');
    refresh.resolve(); assert.equal(await first, true);
    assert.equal(prompts.length, 1); assert.equal(replacements.length, 1);
    assert.equal(document.activeElement, button); assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-busy'), 'false');
  });
});

for (const flags of [{ syncPending: true }, { dailyUsageSyncPending: true }, { syncPending: true, dailyUsageSyncPending: true }]) {
  test(`a committed import with ${JSON.stringify(flags)} completes once and retains safe pending feedback`, async t => {
    await withImport(t, async ({ manager, replacements, input, status, button }) => {
      manager.rulesClient.replaceAll = async backup => { replacements.push(backup); return { rules: backup.rules, ...flags }; };
      input.value = 'backup.json';
      await manager.importRules(file());
      assert.equal(replacements.length, 1); assert.equal(input.value, '');
      assert.equal(status.textContent, 'ruleschangessavedpending');
      assert.equal(status.classList.contains('error'), true);
      assert.equal(button.getAttribute('aria-busy'), 'false');
    });
  });
}

for (const content of ['{broken', '{}', 'null', 'true', '42', '"rules"', '[]', '{"rules":[{"blockURL":12}]}']) {
  test(`invalid backup ${content} gets a localized message without changing rules`, async t => {
    await withImport(t, async ({ manager, status, input, replacements, prompts }) => {
      input.value = 'bad.json';
      await manager.importRules(file(content));
      assert.equal(status.textContent, 'importinvalidbackup');
      assert.equal(status.classList.contains('error'), true);
      assert.equal(input.value, ''); assert.equal(replacements.length + prompts.length, 0);
    });
  });
}

test('wrong file extension and oversized files are rejected before reading their contents', async t => {
  await withImport(t, async ({ manager, input, button, status, replacements }) => {
    for (const [name, size, expected] of [['backup.txt', 1, 'errorinvalidfiletype'], ['backup.json', MAX_BACKUP_FILE_BYTES + 1, 'importfiletoolarge']]) {
      input.value = name;
      await manager.importRules(file('', { name, size, text() { assert.fail('rejected file was read'); } }));
      assert.equal(status.textContent, expected); assert.equal(input.value, '');
      assert.equal(button.getAttribute('aria-busy'), 'false');
    }
    assert.equal(replacements.length, 0);
  });
});

test('content-length fallback uses the size message and the exact size boundary remains valid', async t => {
  await withImport(t, async ({ manager, status, replacements }) => {
    await manager.importRules(file(' '.repeat(MAX_BACKUP_FILE_BYTES + 1)));
    assert.equal(status.textContent, 'importfiletoolarge');
    assert.equal(replacements.length, 0);
    const boundary = '{"rules":[]}'.padEnd(MAX_BACKUP_FILE_BYTES, ' ');
    await manager.importRules(file(boundary, { name: 'BACKUP.JSON', size: MAX_BACKUP_FILE_BYTES }));
    assert.equal(replacements.length, 1);
  });
});

test('a file read failure keeps technical details private and permits an explicit same-file retry', async t => {
  await withImport(t, async ({ manager, status, button, replacements }) => {
    let reads = 0;
    const backup = file('', { async text() { if (++reads === 1) throw new Error('private-file.example/token'); return '{"rules":[]}'; } });
    await manager.importRules(backup);
    assert.equal(status.textContent, 'importfailed');
    assert.equal(button.getAttribute('aria-disabled'), 'false');
    await manager.importRules(backup); assert.equal(replacements.length, 1);
  });
});

for (const code of ['validation_failed', 'invalid_import', 'import_failed']) {
  test(`worker ${code} uses safe localized feedback and never applies uncommitted settings`, async t => {
    await withImport(t, async ({ manager, status, replacements }) => {
      const error = Object.assign(new Error('private.runtime.example/secret'), { code, validationErrors: ['private.rule.example'] });
      manager.rulesClient.replaceAll = async () => { throw error; };
      manager.applySettingsToUI = () => assert.fail('uncommitted settings applied');
      await manager.importRules(file());
      assert.equal(status.textContent, code === 'import_failed' ? 'importfailed' : 'importinvalidbackup');
      assert.equal(replacements.length, 0);
    });
  });
}

test('strict password-settings errors fail closed with persistent import feedback', async t => {
  await withImport(t, async ({ manager, SettingsManager, PasswordUtils, status, prompts, replacements }) => {
    t.mock.method(SettingsManager, 'getSettings', async options => {
      assert.equal(options.throwOnError, true); throw new Error('private protected-settings failure');
    });
    t.mock.method(PasswordUtils, 'showPasswordModal', () => assert.fail('unsafe password fallback'));
    await manager.importRules(file());
    assert.equal(status.textContent, 'importfailed'); assert.equal(prompts.length + replacements.length, 0);
  });
});

for (const pending of [false, true]) {
  test(`a UI refresh error after commit preserves the saved outcome (syncPending=${pending})`, async t => {
    await withImport(t, async ({ manager, status, replacements, button }) => {
      manager.rulesClient.replaceAll = async backup => { replacements.push(backup); return { rules: backup.rules, syncPending: pending }; };
      manager.loadRuleCount = async () => { throw new Error('private rendering failure'); };
      await manager.importRules(file());
      assert.equal(status.textContent, `${pending ? 'ruleschangessavedpending' : 'importedrules:1'} importrefreshfailed`);
      assert.equal(replacements.length, 1); assert.equal(button.getAttribute('aria-busy'), 'false');
    });
  });
}

for (const fail of [false, true]) {
  test(`late import completion preserves the later Search focus and draft (failure=${fail})`, async t => {
    await withImport(t, async ({ manager, document, search, status }) => {
      const gate = deferred(); manager.rulesClient.replaceAll = () => gate.promise;
      const importing = manager.importRules(file()); await tick();
      search.value = 'later draft'; search.focus();
      if (fail) gate.reject(new Error('private worker failure'));
      else gate.resolve({ rules: [] });
      await importing;
      assert.equal(document.activeElement, search); assert.equal(search.value, 'later draft');
      assert.equal(search.focusCount, 1);
      assert.equal(status.textContent, fail ? 'importfailed' : 'importedrules:1');
    });
  });
}

test('general settings feedback and canceled empty file changes cannot erase an import result', async t => {
  await withImport(t, async ({ manager, status }) => {
    await manager.importRules(file()); manager.showStatus('unrelated settings saved');
    await manager.importRules(undefined);
    assert.equal(status.textContent, 'importedrules:1');
  });
});

test('a later Search choice during chooser access checking prevents a delayed file dialog', async t => {
  await withImport(t, async ({ manager, input, search, status, ProManager }) => {
    const gate = deferred(); t.mock.method(ProManager, 'hasPaidAccess', () => gate.promise);
    input.click = () => assert.fail('late picker stole focus');
    const choosing = manager.chooseImportFile(); search.focus(); gate.resolve(true);
    assert.equal(await choosing, false); assert.equal(status.textContent, 'importcancelled');
  });
});

test('a later focus choice during file reading cancels before password or native confirmation', async t => {
  await withImport(t, async ({ manager, search, status, prompts, replacements }) => {
    const gate = deferred();
    manager.checkPasswordProtection = async () => assert.fail('late password modal stole focus');
    const importing = manager.importRules(file('', { text: () => gate.promise })); await tick();
    search.value = 'new task'; search.focus(); gate.resolve('{"rules":[]}');
    assert.equal(await importing, false); assert.equal(status.textContent, 'importcancelled');
    assert.equal(prompts.length + replacements.length, 0); assert.equal(search.value, 'new task');
  });
});

test('a later focus choice while protected settings load prevents a delayed password prompt', async t => {
  await withImport(t, async ({ manager, SettingsManager, PasswordUtils, search, status, prompts }) => {
    const gate = deferred(); t.mock.method(SettingsManager, 'getSettings', () => gate.promise);
    t.mock.method(PasswordUtils, 'showPasswordModal', () => assert.fail('obsolete prompt opened'));
    const importing = manager.importRules(file()); await tick(); search.focus();
    gate.resolve({ enablePassword: true }); assert.equal(await importing, false);
    assert.equal(status.textContent, 'importcancelled'); assert.equal(prompts.length, 0);
  });
});

for (const boundary of ['hidden document', 'unfocused document', 'hidden panel', 'focus lock', 'other dialog', 'detached opener']) {
  test(`an import cannot open a delayed confirmation in a ${boundary}`, async t => {
    await withImport(t, async ({ manager, document, button, status, prompts, replacements }) => {
      const gate = deferred(); const importing = manager.importRules(file('', { text: () => gate.promise }));
      await tick();
      if (boundary === 'hidden document') document.visibilityState = 'hidden';
      if (boundary === 'unfocused document') document.hasFocus = () => false;
      if (boundary === 'hidden panel') button.hidden = true;
      if (boundary === 'focus lock') button.classList.add('focus-lock-active');
      if (boundary === 'other dialog') document.addElement('other-dialog', 'dialog').setAttribute('open', '');
      if (boundary === 'detached opener') button.isConnected = false;
      gate.resolve('{"rules":[]}'); assert.equal(await importing, false);
      assert.equal(status.textContent, 'importcancelled'); assert.equal(prompts.length + replacements.length, 0);
    });
  });
}

test('the actual file change listener observes the early guard and leaves the button focusable', async t => {
  await withImport(t, async ({ manager, input, button, status, replacements }) => {
    manager.setupEventListeners(); const gate = deferred();
    input.files = [file('', { text: () => gate.promise })];
    const first = input.dispatch('change'); await tick();
    input.files = [file('{"rules":[{"blockURL":"ignored.example"}]}')];
    await input.dispatch('change'); await button.dispatch('click');
    gate.resolve('{"rules":[]}'); await first;
    assert.equal(replacements.length, 1); assert.equal(status.textContent, 'importedrules:0');
    assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-busy'), 'false');
  });
});
