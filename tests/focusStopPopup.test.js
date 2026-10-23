import test from 'node:test';
import assert from 'node:assert/strict';
import { popupFocusFixture } from './helpers/popupFocusFixture.js';

function createPopup(options = {}) {
  const view = popupFocusFixture(options);
  const state = { focusActive: true, focusEndTime: Date.now() + 60000, isHardcore: false, focusMode: 'blacklist' };
  view.state(state); view.controller.focusViewState = state; return view;
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
    assert.deepEqual(view.alerts, response?.syncPending ? ['ruleschangessavedpending'] : warning ? ['errorupdatingrules'] : response?.superseded ? [] : ['focussessionended']);
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
