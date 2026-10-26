import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

test('Listen has a single pending request, keeps later focus/drafts and does not toggle the saved preference', async () => {
  const document = new FakeDocument(), button = document.addElement('previewFocusSound', 'button');
  const status = document.addElement('focusSoundStatus');
  const field = document.addElement('search', 'input'); field.value = 'later draft';
  const api = createExtensionApi({ sync: { settings: { focusSessionSound: false } } });
  let resolve, messages = 0;
  api.runtime.sendMessage = () => { messages++; return new Promise(r => { resolve = r; }); };
  await withExtensionEnvironment(api, async () => {
    const { SettingsManager } = await import('../options/settings.js');
    const manager = Object.create(SettingsManager.prototype);
    button.focus(); const work = manager.previewFocusSound();
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    await manager.previewFocusSound(); assert.equal(messages, 1);
    field.focus(); resolve({ success: true }); await work;
    assert.equal(document.activeElement, field); assert.equal(field.value, 'later draft');
    assert.equal(status.textContent, 'soundpreviewcomplete'); assert.equal(button.getAttribute('aria-busy'), 'false');
    assert.deepEqual(api.storage.sync.data.settings, { focusSessionSound: false });
  }, { document });
});

for (const failure of ['reject', 'failure', 'missing']) test(`preview ${failure} leaves an accessible error and allows one explicit retry`, async () => {
  const document = new FakeDocument(), button = document.addElement('previewFocusSound', 'button');
  const status = document.addElement('focusSoundStatus'); const api = createExtensionApi();
  api.runtime.sendMessage = async () => {
    if (failure === 'reject') throw new Error('connection closed');
    return failure === 'failure' ? { success: false } : undefined;
  };
  await withExtensionEnvironment(api, async () => {
    const { SettingsManager } = await import('../options/settings.js');
    const manager = Object.create(SettingsManager.prototype);
    await manager.previewFocusSound(); assert.equal(status.textContent, 'soundpreviewfailed');
    assert.equal(button.getAttribute('aria-disabled'), 'false');
    api.runtime.sendMessage = async () => ({ success: true });
    await manager.previewFocusSound(); assert.equal(status.textContent, 'soundpreviewcomplete');
  }, { document });
});
