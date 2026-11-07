import test from 'node:test';
import assert from 'node:assert/strict';
import { popupFocusFixture } from './helpers/popupFocusFixture.js';

function fixture() {
  const f = popupFocusFixture();
  const group = f.document.addElement('rule-editing-controls', 'fieldset');
  const controls = f.document.getElementById('controls');
  group.appendChild(controls);group.appendChild(f.c.rulesContainer);
  const add = f.document.createElement('button');controls.appendChild(add);
  const whitelist = f.document.createElement('button');whitelist.disabled = true;controls.appendChild(whitelist);
  return { ...f, group, add, whitelist };
}

test('active Focus disables the native editing group and unlocks it after Stop', async () => {
  const f = fixture();await f.ready();
  f.state({ focusActive: true, focusEndTime: Date.now()+60000 });await f.c.updateFocusUI();
  assert.equal(f.group.disabled, true);
  assert.equal(f.c.rulesContainer.classList.contains('focus-lock-active'), true);
  f.state({});await f.c.updateFocusUI();
  assert.equal(f.group.disabled, false);
  assert.equal(f.whitelist.disabled, true, 'unlock preserves an independently unavailable action');
  assert.equal(f.add.disabled, false);
});

test('late button updates and newly rendered editors cannot release the native Focus lock', async () => {
  const f = fixture();f.state({ focusActive: true, focusEndTime: Date.now()+60000 });await f.ready();
  f.whitelist.disabled = false;
  const draft = f.document.createElement('input');f.c.rulesContainer.appendChild(draft);
  assert.equal(f.group.disabled, true, 'fieldset still disables descendants whose own disabled flag is false');
  assert.equal(f.group.contains(draft), true);
  await f.c.updateFocusUI();
  assert.equal(f.group.disabled, true);
});

test('a failed Focus read retains the native editing lock until a verified inactive state', async () => {
  const f = fixture();f.state({ focusActive: true, focusEndTime: Date.now()+60000 });await f.ready();
  f.read(() => { throw new Error('storage unavailable'); });await f.c.updateFocusUI();
  assert.equal(f.group.disabled, true);
  assert.equal(f.fields.stopFocusBtn.hidden, false);
  f.read(() => ({ focusActive: false }));await f.c.updateFocusUI();
  assert.equal(f.group.disabled, false);
});
