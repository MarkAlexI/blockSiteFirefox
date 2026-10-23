import test from 'node:test';
import assert from 'node:assert/strict';
import { customAlert } from '../scripts/customAlert.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

async function notifications(run) {
  const document = new FakeDocument();
  document.defaultView = new FakeDocument();
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const tasks = new Map();
  const callbacks = [];
  let now = 0, nextId = 0;
  globalThis.setTimeout = (callback, delay) => {
    callbacks.push(callback);
    tasks.set(++nextId, { callback, at: now + delay });
    return nextId;
  };
  globalThis.clearTimeout = id => tasks.delete(id);
  const tick = ms => {
    const end = now + ms;
    for (;;) {
      const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      tasks.delete(next[0]);
      next[1].callback();
    }
    now = end;
  };
  try {
    await withExtensionEnvironment(createExtensionApi(), () => run({ document, tick, tasks, callbacks }), { document });
  } finally {
    await document.defaultView.dispatch('pagehide');
    Object.assign(globalThis, original);
  }
}

test('notifications update one pre-existing polite status after mounting, preserve focus and treat HTML as text', () => notifications(({ document, tick }) => {
  const region = document.addElement('custom-alert');
  const input = document.addElement('draft', 'input');
  input.value = 'unfinished rule';
  input.focus();
  customAlert('<img src=x onerror=alert(1)>');
  assert.equal(region.getAttribute('role'), 'status');
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.getAttribute('aria-atomic'), 'true');
  assert.equal(region.textContent, '', 'the live region exists before its content changes');
  assert.equal(region.getAttribute('tabindex'), null);
  tick(150);
  assert.equal(region.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(region.children.length, 0);
  assert.equal(region.getAttribute('tabindex'), '0');
  assert.equal(document.activeElement, input);
  assert.equal(input.value, 'unfinished rule');
  tick(5_000);
  assert.equal(region.textContent, '');
  assert.equal(region.getAttribute('tabindex'), null);
  assert.equal(document.getElementById('custom-alert'), region, 'empty live region stays mounted');
  assert.equal(document.activeElement, input);
}));

test('rapid distinct and identical notifications are shown in order with empty updates between repeats', () => notifications(({ document, tick, callbacks }) => {
  customAlert('Saved');
  customAlert('Saved');
  customAlert('Saved; synchronization pending');
  const region = document.getElementById('custom-alert');
  tick(150);
  assert.equal(region.textContent, 'Saved');
  const expired = callbacks.at(-1);
  tick(4_950);
  assert.equal(region.textContent, '', 'clear the first message before repeating its text');
  tick(150);
  assert.equal(region.textContent, 'Saved');
  expired();
  assert.equal(region.textContent, 'Saved', 'a stale expiry cannot clear the next notification');
  tick(5_100);
  assert.equal(region.textContent, 'Saved; synchronization pending');
  tick(5_100);
  assert.equal(region.textContent, '');
  assert.equal(document.querySelectorAll('#custom-alert').length, 1);
}));

test('long translated notifications stay readable longer than short notifications', () => notifications(({ document, tick }) => {
  const message = 'Довге повідомлення про збереження та синхронізацію. '.repeat(20);
  customAlert(message);
  tick(150);
  assert.equal(document.getElementById('custom-alert').textContent, message.trim());
  tick(20_000);
  assert.equal(document.getElementById('custom-alert').textContent, message.trim());
  tick(60_000);
  assert.equal(document.getElementById('custom-alert').textContent, '');
}));

test('a hidden page preserves current and queued notifications until the page becomes visible', () => notifications(async ({ document, tick }) => {
  customAlert('First'); customAlert('Second');
  tick(150);
  document.hidden = true;
  await document.dispatch('visibilitychange');
  const region = document.getElementById('custom-alert');
  assert.equal(region.textContent, '');
  tick(60_000);
  document.hidden = false;
  await document.dispatch('visibilitychange');
  tick(150);
  assert.equal(region.textContent, 'First');
  tick(5_100);
  assert.equal(region.textContent, 'Second');
}));

test('notifications wait outside a modal dialog and resume in order after it closes', () => notifications(async ({ document, tick }) => {
  const dialog = document.addElement('gate', 'dialog');
  dialog.setAttribute('open', '');
  const password = document.createElement('input');
  dialog.appendChild(password);
  password.focus();
  customAlert('Saved'); customAlert('Pending');
  tick(60_000);
  const region = document.getElementById('custom-alert');
  assert.equal(region.textContent, '');
  assert.equal(document.activeElement, password);
  dialog.removeAttribute('open');
  await document.dispatch('close', { target: dialog });
  tick(150);
  assert.equal(region.textContent, 'Saved');
  dialog.setAttribute('open', '');
  await document.dispatch('focusin', { target: password });
  tick(60_000);
  assert.equal(region.textContent, '');
  dialog.remove();
  await document.dispatch('focusin');
  tick(150);
  assert.equal(region.textContent, 'Saved', 'interrupted message receives a fresh reading interval');
  tick(5_100);
  assert.equal(region.textContent, 'Pending');
}));

test('hover pauses expiry without changing the message or focus', () => notifications(async ({ document, tick }) => {
  customAlert('Read this');
  tick(150);
  const region = document.getElementById('custom-alert');
  await region.dispatch('pointerenter');
  tick(60_000);
  assert.equal(region.textContent, 'Read this');
  await region.dispatch('pointerleave');
  tick(5_100);
  assert.equal(region.textContent, '');
}));

test('keyboard focus pauses a scrollable notification until the user moves to another control', () => notifications(async ({ document, tick }) => {
  const next = document.addElement('next', 'button');
  customAlert('Long notice'); customAlert('Next notice');
  tick(150);
  const region = document.getElementById('custom-alert');
  region.focus();
  await document.dispatch('focusin', { target: region });
  tick(60_000);
  assert.equal(region.textContent, 'Long notice');
  assert.equal(document.activeElement, region);
  next.focus();
  await document.dispatch('focusin', { target: next });
  tick(5_100);
  assert.equal(region.textContent, 'Next notice');
  assert.equal(document.activeElement, next);
}));

test('pagehide cancels queued work, removes listeners and cannot clear a later notification', () => notifications(async ({ document, tick, tasks, callbacks }) => {
  customAlert('Old'); customAlert('Never display');
  tick(150);
  const oldCallbacks = [...callbacks];
  const region = document.getElementById('custom-alert');
  await document.defaultView.dispatch('pagehide');
  assert.equal(tasks.size, 0);
  assert.equal(region.textContent, '');
  assert.equal(document.listeners.get('visibilitychange').length, 0);
  customAlert('New page session');
  tick(150);
  for (const callback of oldCallbacks) callback();
  assert.equal(region.textContent, 'New page session');
  tick(5_100);
  assert.equal(region.textContent, '');
}));

test('empty notifications do not create a region or delay valid feedback', () => notifications(({ document, tick, tasks }) => {
  customAlert('  '); customAlert(null); customAlert(undefined);
  assert.equal(document.getElementById('custom-alert'), null);
  assert.equal(tasks.size, 0);
  customAlert('Useful');
  tick(150);
  assert.equal(document.getElementById('custom-alert').textContent, 'Useful');
}));
