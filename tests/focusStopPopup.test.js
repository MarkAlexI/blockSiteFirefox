import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const start = source.indexOf('  async stopFocusSession() {');
const end = source.indexOf('\n  logRulesMutationFailure(', start);
assert.ok(start >= 0 && end > start);
const method = source.slice(start, end);

function createPopup({ response = { success: true }, messageError, refreshError } = {}) {
  const messages = [];
  const alerts = [];
  const errors = [];
  let refreshes = 0;
  const api = { runtime: { async sendMessage(message) {
    messages.push(message);
    if (messageError) throw messageError;
    return response;
  } } };
  const Controller = new Function('browser', 'chrome', 'customAlert', 't',
    'return class PopupStop {\n' + method + '\n};'
  )(api, api, text => alerts.push(text), key => key);
  const controller = new Controller();
  controller.logger = { error: (...args) => errors.push(args) };
  controller.updateFocusUI = async () => {
    refreshes++;
    if (refreshError) throw refreshError;
  };
  return { controller, messages, alerts, errors, get refreshes() { return refreshes; } };
}

for (const [label, response, warning] of [
  ['confirmed Stop', { success: true }, false],
  ['superseded Stop', { success: true, superseded: true }, false],
  ['pending DNR sync', { success: true, syncPending: true }, true],
  ['failed Stop', { success: false, error: 'internal storage detail' }, true],
  ['missing reply', null, true],
  ['empty reply', {}, true]
]) {
  test('Popup Stop refreshes stored state and handles ' + label, async () => {
    const view = createPopup({ response });
    await view.controller.stopFocusSession();
    assert.deepEqual(view.messages, [{ type: 'stop_focus_session' }]);
    assert.equal(view.refreshes, 1);
    assert.deepEqual(view.alerts, warning ? ['errorupdatingrules'] : []);
  });
}

test('Popup Stop contains a rejected message and refreshes actual Focus state', async () => {
  const view = createPopup({ messageError: new Error('message channel closed') });
  await view.controller.stopFocusSession();
  assert.equal(view.refreshes, 1);
  assert.equal(view.errors.length, 1);
  assert.deepEqual(view.alerts, ['errorupdatingrules']);
});

test('Popup Stop contains a failed refresh without an unhandled click rejection', async () => {
  const view = createPopup({ refreshError: new Error('UI refresh failed') });
  await view.controller.stopFocusSession();
  assert.equal(view.refreshes, 1);
  assert.equal(view.errors.length, 1);
  assert.deepEqual(view.alerts, ['errorupdatingrules']);
});

test('Popup Stop shows one localized warning when both the message and refresh reject', async () => {
  const view = createPopup({
    messageError: new Error('message channel closed'), refreshError: new Error('UI refresh failed')
  });
  await view.controller.stopFocusSession();
  assert.equal(view.refreshes, 1);
  assert.equal(view.errors.length, 2);
  assert.deepEqual(view.alerts, ['errorupdatingrules']);
});
