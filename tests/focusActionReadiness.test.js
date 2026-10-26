import test from 'node:test';
import assert from 'node:assert/strict';
import { readFocusActionReadiness } from '../e2e/focus-action-readiness.mjs';
import { popupFocusFixture } from './helpers/popupFocusFixture.js';

function reader(f) {
  for (const key of ['startFocusBtn', 'stopFocusBtn']) f.fields[key].getClientRects = () => [{}];
  return kind => new Function('document', 'kind', `return (${readFocusActionReadiness.toString()})(kind);`)(f.document, kind);
}
test('a production storage refresh can expose Stop while Start still rejects its activation', async () => {
  const f = popupFocusFixture(); const read = reader(f); await f.ready();
  let release; const reply = new Promise(resolve => { release = resolve; });
  f.send(() => reply); await f.focus(f.fields.startFocusBtn);
  const starting = f.c.startFocusSession();
  try {
    f.state({ focusActive: true, focusEndTime: Date.now() + 60_000 });
    await f.c.updateFocusUI();
    assert.equal(f.c.rulesContainer.classList.contains('focus-lock-active'), true, 'old E2E condition already passes');
    assert.equal(read('stop').visible, true);
    assert.equal(read('stop').ready, false, 'actual acknowledgement remains pending');
    await f.c.stopFocusSession();
    assert.deepEqual(f.messages.map(m => m.type), ['start_focus_session'], 'premature Stop is correctly guarded');
  } finally { release({ success: true }); await starting; }
  await f.focus(f.other);
  assert.equal(read('stop').ready, true);
  assert.equal(f.document.activeElement, f.other, 'readiness does not focus or activate a control');
  f.send(message => { assert.equal(message.type, 'stop_focus_session'); f.state({}); return { success: true }; });
  await f.focus(f.fields.stopFocusBtn); await f.c.stopFocusSession();
  assert.deepEqual(f.messages.map(m => m.type), ['start_focus_session', 'stop_focus_session']);
  assert.equal(read('start').ready, true);
});
test('readiness rejects inactive and Hardcore-hidden actions', async () => {
  const f = popupFocusFixture(); const read = reader(f); await f.ready();
  assert.equal(read('start').ready, true); assert.equal(read('stop').ready, false);
  f.state({ focusActive: true, focusEndTime: Date.now() + 60_000, isHardcore: true });
  await f.c.updateFocusUI();
  assert.equal(read('start').ready, false); assert.equal(read('stop').ready, false);
});
test('readiness requires both the action and its group to be available', async () => {
  const f = popupFocusFixture(); const read = reader(f); await f.ready();
  for (const [node,attribute] of [[f.fields.focusControls,'aria-busy'],[f.fields.startFocusBtn,'aria-disabled']]) {
    node.setAttribute(attribute,'true'); assert.equal(read('start').ready,false); node.removeAttribute(attribute);
  }
  f.fields.startFocusBtn.disabled=true; assert.equal(read('start').ready,false);
  f.fields.startFocusBtn.disabled=false; assert.equal(read('start').ready,true);
  assert.throws(()=>read('typo'),/Unknown Focus action/);
});
