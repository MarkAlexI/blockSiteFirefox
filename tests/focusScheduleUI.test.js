import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './helpers/extensionTestHarness.js';
import { FocusScheduleUI, revealFocusSchedule } from '../schedules/focusScheduleUI.js';

function fixture({ withRestore = true } = {}) {
  const doc = new FakeDocument();
  doc.defaultView = new FakeDocument();
  const root = doc.createElement('details');
  doc.body.appendChild(root);
  root.open = false;
  const scrolls = [];
  root.scrollIntoView = options => scrolls.push(options);
  const form = doc.createElement('form');
  root.appendChild(form);
  const field = (name, type = 'input') => {
    const el = doc.createElement(type);
    el.name = name;
    form.appendChild(el);
    return el;
  };
  form.elements = { enabled: field('enabled'), startTime: field('startTime'), durationMinutes: field('durationMinutes') };
  for (let i = 0; i < 7; i++) field('day').value = String(i);
  field('save', 'button');
  for (const name of ['status','skipped','notice','skip','restore','access','reset']) {
    if (name === 'restore' && !withRestore) continue;
    const el = doc.createElement(['skip','restore','reset'].includes(name) ? 'button' : 'p');
    el.setAttribute('data-focus-' + name, '');
    if (name === 'status' || name === 'notice') el.setAttribute('aria-live', 'polite');
    if (name === 'notice') el.setAttribute('role', 'status');
    root.appendChild(el);
  }
  let state = { success: true, hasAccess: true, revision: 1, config: {
    enabled: true, days: [1,3,5], startTime: '09:00', durationMinutes: 50
  }, next: { key: '2026-10-02@09:00', startTime: new Date(2026,9,2,9).getTime() }, skipped: null };
  const calls = [];
  let fail = false;
  const ui = new FocusScheduleUI(root, {
    translate: (key, value) => value ? key + ': ' + value : key,
    send: async message => {
      calls.push(message);
      if (fail) return { success: false, code: 'schedule_changed' };
      if (message.type === 'focus_schedule_save') state = { ...state, config: message.config, revision: state.revision + 1 };
      return structuredClone(state);
    }
  });
  return { root, scrolls, ui, form, calls, setState: value => { state = { ...state, ...value }; }, fail: () => { fail = true; } };
}

test('schedule form saves exact selected days/time/duration and original revision', async () => {
  const f = fixture();
  await f.ui.init();
  assert.equal(f.form.elements.startTime.value, '09:00');
  f.form.elements.startTime.value = '10:15';
  f.form.elements.durationMinutes.value = '45';
  await f.ui.save();
  assert.deepEqual(f.calls.at(-1), { type: 'focus_schedule_save', revision: 1,
    config: { enabled: true, days: [1,3,5], startTime: '10:15', durationMinutes: 45 } });
  assert.equal(f.ui.notice.textContent, 'settingssaved');
});

test('background refresh preserves edits and their revision; save failure retains the draft', async () => {
  const f = fixture();
  await f.ui.init();
  f.ui.dirty = true;
  f.form.elements.startTime.value = '11:00';
  f.setState({ revision: 2, config: { enabled: true, days: [2], startTime: '12:00', durationMinutes: 40 } });
  await f.ui.refresh();
  assert.equal(f.form.elements.startTime.value, '11:00');
  assert.equal(f.ui.formRevision, 1);
  f.fail();
  await f.ui.save();
  assert.equal(f.ui.notice.textContent, 'focus_schedule_changed');
  assert.equal(f.form.elements.startTime.value, '11:00');
  assert.equal(f.ui.busy, false);
});

test('expired access keeps the off switch available, hides skip and disables new schedules', async () => {
  const f = fixture();
  f.setState({ hasAccess: false });
  await f.ui.init();
  assert.equal(f.form.elements.enabled.disabled, false);
  assert.equal(f.form.elements.startTime.disabled, true);
  assert.equal(f.ui.skip.hidden, true);
  f.setState({ config: { enabled: false, days: [1], startTime: '09:00', durationMinutes: 25 } });
  await f.ui.refresh(true);
  assert.equal(f.form.elements.enabled.disabled, true);
});

test('invalid duration or empty day selection never sends a save', async () => {
  const f = fixture();
  await f.ui.init();
  const count = f.calls.length;
  f.form.elements.durationMinutes.value = '25.5';
  await f.ui.save();
  assert.equal(f.ui.notice.textContent, 'focussessioninvalidduration');
  f.form.elements.durationMinutes.value = '25';
  for (const day of f.form.querySelectorAll('[name="day"]')) day.checked = false;
  await f.ui.save();
  assert.equal(f.ui.notice.textContent, 'invalidschedule');
  assert.equal(f.calls.length, count);
});


test('ordinary Options visits stay closed; the exact schedule fragment reveals and scrolls the editor', async () => {
  const f = fixture();
  await f.ui.init();
  for (const hash of ['', '#privacy-settings', '#focus-schedule-other']) {
    assert.equal(revealFocusSchedule(f.root, hash), false);
    assert.equal(f.root.open, false);
  }
  assert.deepEqual(f.scrolls, []);
  const requests = f.calls.length;
  assert.equal(revealFocusSchedule(f.root, '#focus-schedule'), true);
  assert.equal(f.root.open, true);
  assert.deepEqual(f.scrolls, [{ block: 'start' }]);
  assert.equal(f.calls.length, requests);
  assert.equal(revealFocusSchedule(null, '#focus-schedule'), false);
  assert.equal(revealFocusSchedule({ tagName: 'DIV' }, '#focus-schedule'), false);
});

test('refresh after manually closing a fragment-opened editor does not reopen it or reset a draft', async () => {
  const f = fixture();
  await f.ui.init();
  revealFocusSchedule(f.root, '#focus-schedule');
  f.form.elements.startTime.value = '11:15';
  f.ui.dirty = true;
  f.root.open = false;
  f.setState({ revision: 2, config: { enabled: true, days: [2], startTime: '12:00', durationMinutes: 40 } });
  await f.ui.refresh();
  assert.equal(f.root.open, false);
  assert.equal(f.form.elements.startTime.value, '11:15');
  assert.equal(f.ui.formRevision, 1);
  assert.equal(f.scrolls.length, 1);
});

test('stale intent: a delayed Cancel refresh cannot overwrite a newly typed schedule draft', async () => {
  const f = fixture();
  await f.ui.init();
  let release;
  f.ui.send = () => new Promise(resolve => { release = resolve; });
  const pending = f.ui.refresh(true);
  f.form.elements.startTime.value = '11:15';
  f.form.dispatchEvent({ type: 'input' });
  release({ ...f.ui.state, revision: 2, config: { ...f.ui.state.config, startTime: '12:00' } });
  await pending;
  assert.equal(f.form.elements.startTime.value, '11:15');
  assert.equal(f.ui.formRevision, 1);
  assert.equal(f.ui.dirty, true);
});

test('stale intent: Skip click sends the revision and absolute start displayed in Options', async () => {
  const f = fixture();
  await f.ui.init();
  const calls = [];
  f.ui.mutate = async message => { calls.push(message); };
  f.ui.skip.dispatchEvent({ type: 'click' });
  assert.deepEqual(calls, [{ type: 'focus_schedule_skip', key: f.ui.state.next.key,
    revision: 1, startTime: f.ui.state.next.startTime }]);
});

function undoFixture() {
  const f = fixture();
  const occurrence = { key: 'future-local-key', startTime: Date.now() + 3600000 };
  f.setState({ restorable: occurrence, skipped: occurrence });
  return { ...f, occurrence };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function nativeActionFocus(button) {
  const doc = button.ownerDocument;
  let disabled = button.disabled;
  // Model native focus loss on disabling; FakeElement keeps focus otherwise.
  Object.defineProperty(button, 'disabled', {
    get: () => disabled,
    set(value) { disabled = value; if (value && doc.activeElement === button) doc.activeElement = doc.body; }
  });
}

test('Skip and Undo remain focusable when the Options form contains their action buttons', async () => {
  const f = undoFixture();await f.ui.init();
  for (const button of [f.ui.skip, f.ui.restore]) { button.remove();f.form.appendChild(button); }
  nativeActionFocus(f.ui.restore);f.ui.restore.focus();
  let release;
  f.ui.send = () => new Promise(resolve => { release = resolve; });
  const pending = f.ui.mutate({ type: 'focus_schedule_restore', revision: 1 });
  try {
    assert.equal(f.ui.restore.disabled, false);
    assert.equal(f.ui.skip.disabled, false);
    assert.equal(f.ui.restore.getAttribute('aria-disabled'), 'true');
    assert.equal(f.root.ownerDocument.activeElement, f.ui.restore);
    assert.equal(f.form.elements.startTime.disabled, true);
  } finally {
    release({ success: false, code: 'focus_schedule_failed' });
    await pending;
  }
  assert.equal(f.root.ownerDocument.activeElement, f.ui.restore);
});

test('pending Skip retains its native focus and guards both schedule actions', async () => {
  const f = undoFixture();await f.ui.init();nativeActionFocus(f.ui.skip);f.ui.skip.focus();
  let release;const calls = [];
  f.ui.send = input => { calls.push(input);return new Promise(resolve => { release = resolve; }); };
  const first = f.ui.mutate({ type: 'focus_schedule_skip', revision: 1 });
  try {
    await f.ui.mutate({ type: 'focus_schedule_skip', revision: 1 });
    await f.ui.mutate({ type: 'focus_schedule_restore', revision: 1 });
    assert.equal(calls.length, 1);
    assert.equal(f.ui.skip.disabled, false);
    assert.equal(f.ui.skip.getAttribute('aria-disabled'), 'true');
    assert.equal(f.ui.restore.getAttribute('aria-disabled'), 'true');
    assert.equal(f.root.getAttribute('aria-busy'), 'true');
    assert.equal(f.root.ownerDocument.activeElement, f.ui.skip);
  } finally {
    release({ ...f.ui.state, success: true, revision: 2 });
    await first;
  }
  assert.equal(f.root.ownerDocument.activeElement, f.ui.skip);
  assert.equal(f.ui.skip.getAttribute('aria-disabled'), null);
  assert.equal(f.ui.restore.getAttribute('aria-disabled'), null);
  assert.equal(f.root.getAttribute('aria-busy'), null);
});

for (const failure of ['schedule_changed', 'focus_schedule_failed', 'transport']) {
  test(`failed Undo keeps its native focus and permits retry after ${failure}`, async () => {
    const f = undoFixture();await f.ui.init();nativeActionFocus(f.ui.restore);f.ui.restore.focus();
    const state = { ...f.ui.state, success: true };
    const calls = [];
    f.ui.send = async input => {
      calls.push(input.type);
      if (input.type === 'focus_schedule_get') return state;
      if (failure === 'transport') throw new Error('transport unavailable');
      return { success: false, code: failure };
    };
    await f.ui.mutate({ type: 'focus_schedule_restore', revision: 1 });
    assert.equal(f.ui.restore.hidden, false);
    assert.equal(f.root.ownerDocument.activeElement, f.ui.restore);
    assert.equal(f.ui.restore.disabled, false);
    assert.equal(f.ui.restore.getAttribute('aria-disabled'), null);
    assert.equal(f.root.getAttribute('aria-busy'), null);
    assert.equal(calls.length, failure === 'schedule_changed' ? 2 : 1);
    f.ui.send = async () => ({ ...state, revision: 2, restorable: null, skipped: null });
    await f.ui.mutate({ type: 'focus_schedule_restore', revision: 1 });
    assert.equal(f.ui.restore.hidden, true);
    assert.equal(f.root.ownerDocument.activeElement, f.ui.skip);
  });
}

for (const suspended of ['hidden', 'dialog']) {
  test(`Undo never moves focus into a ${suspended} document context`, async () => {
    const f = undoFixture();await f.ui.init();f.ui.restore.focus();
    let release;
    f.ui.send = () => new Promise(resolve => { release = resolve; });
    const pending = f.ui.mutate({ type: 'focus_schedule_restore', revision: 1 });
    const doc = f.root.ownerDocument;
    if (suspended === 'hidden') doc.hidden = true;
    else { const dialog = doc.createElement('dialog');dialog.setAttribute('open', '');doc.body.appendChild(dialog); }
    // Hiding the old control moves native focus to the body.
    f.ui.restore.hidden = true;doc.activeElement = doc.body;
    release({ ...f.ui.state, success: true, revision: 2, restorable: null, skipped: null });
    await pending;
    assert.equal(doc.activeElement, doc.body);
  });
}


test('Undo shows the exact future occurrence and sends its displayed revision and absolute start', async () => {
  const f = undoFixture();await f.ui.init();
  assert.equal(f.ui.restore.hidden, false);
  assert.match(f.ui.restore.textContent, /^focus_schedule_restore: /);
  const calls = [];f.ui.mutate = async input => calls.push(input);
  f.ui.restore.dispatchEvent({ type: 'click' });
  assert.deepEqual(calls, [{ type: 'focus_schedule_restore', key: f.occurrence.key,
    revision: 1, startTime: f.occurrence.startTime }]);
});

test('Undo is hidden without access, without a skipped future session, or at its start', async () => {
  const f = undoFixture();await f.ui.init();
  for (const change of [{ hasAccess: false }, { restorable: null },
    { restorable: { ...f.occurrence, startTime: Date.now() } }]) {
    f.ui.render({ ...f.ui.state, hasAccess: true, restorable: f.occurrence, ...change });
    assert.equal(f.ui.restore.hidden, true);
  }
});

test('Undo blocks duplicate pending actions and returns keyboard focus when its button disappears', async () => {
  const f = undoFixture();await f.ui.init();
  const focusListeners = [...(f.root.ownerDocument.listeners.get('focusin') || [])];
  f.ui.restore.focus();let release;const calls = [];
  f.ui.send = input => { calls.push(input);return new Promise(resolve => { release = resolve; }); };
  f.ui.restore.dispatchEvent({ type: 'click' });f.ui.restore.dispatchEvent({ type: 'click' });
  assert.equal(calls.length, 1);
  assert.equal(f.ui.skip.disabled, false);assert.equal(f.ui.restore.disabled, false);
  assert.equal(f.ui.skip.getAttribute('aria-disabled'), 'true');
  assert.equal(f.ui.restore.getAttribute('aria-disabled'), 'true');
  release({ ...f.ui.state, success: true, revision: 2, restorable: null, skipped: null });
  await settle();
  assert.equal(f.ui.busy, false);assert.equal(f.ui.restore.hidden, true);
  assert.equal(f.root.ownerDocument.activeElement, f.ui.skip);
  assert.deepEqual(f.root.ownerDocument.listeners.get('focusin'), focusListeners);
  assert.deepEqual(f.root.ownerDocument.listeners.get('pointerdown'), []);
});

test('a later focus choice is preserved after Undo completes', async () => {
  const f = undoFixture();await f.ui.init();f.ui.restore.focus();
  let release;f.ui.send = () => new Promise(resolve => { release = resolve; });
  f.ui.restore.dispatchEvent({ type: 'click' });
  const later = f.form.elements.startTime;later.focus();
  await f.root.ownerDocument.dispatch('focusin', { target: later });
  release({ ...f.ui.state, success: true, revision: 2, restorable: null });await settle();
  assert.equal(f.root.ownerDocument.activeElement, later);
});

test('Skip/Undo revision changes retain drafts without stranding their save token', async () => {
  const f = undoFixture();await f.ui.init();
  f.ui.dirty = true;f.form.elements.startTime.value = '11:15';
  f.ui.send = async () => ({ ...f.ui.state, success: true, revision: 2 });
  await f.ui.mutate({ type: 'focus_schedule_restore', revision: 1 });
  assert.equal(f.form.elements.startTime.value, '11:15');assert.equal(f.ui.formRevision, 2);
  f.ui.render({ ...f.ui.state, revision: 3, config: { ...f.ui.state.config, startTime: '12:00' } }, false);
  assert.equal(f.ui.formRevision, 2);
  f.ui.render({ ...f.ui.state, revision: 4 }, false);
  assert.equal(f.ui.formRevision, 2, 'a subsequent skip cannot legitimize the old config draft');
});

test('a passive A-B-A refresh cannot legitimize an old schedule draft even if config matches again', async () => {
  const f = undoFixture();await f.ui.init();
  f.ui.dirty = true;f.form.elements.startTime.value = '11:15';
  f.ui.render({ ...f.ui.state, revision: 3 }, false);
  assert.equal(f.ui.formRevision, 1);
  assert.equal(f.form.elements.startTime.value, '11:15');
});

test('a stale Undo refreshes the displayed occurrence without replaying the action', async () => {
  const f = undoFixture();await f.ui.init();const calls = [];
  const fresh = { ...f.ui.state, revision: 2, restorable: null };
  f.ui.send = async input => { calls.push(input);return input.type === 'focus_schedule_get'
    ? { success: true, ...fresh } : { success: false, code: 'schedule_changed' }; };
  await f.ui.mutate({ type: 'focus_schedule_restore', key: f.occurrence.key, revision: 1, startTime: f.occurrence.startTime });
  assert.deepEqual(calls.map(input => input.type), ['focus_schedule_restore','focus_schedule_get']);
  assert.equal(f.ui.restore.hidden, true);
  assert.equal(f.ui.notice.textContent, 'focus_schedule_action_changed');
});

test('a retained pre-update document without Undo markup can still mount the schedule reader', async () => {
  const f = fixture({ withRestore: false });await f.ui.init();
  assert.equal(f.ui.restore, null);assert.equal(f.ui.skip.hidden, false);
});

// Model DOM writes and event ordering here; native scenarios verify the mounted
// live region. These tests make no claim about any screen reader's speech.
function recordTextWrites(element) {
  const writes = [];
  let value = element.textContent;
  Object.defineProperty(element, 'textContent', {
    get: () => value,
    set(text) { value = text; writes.push(text); }
  });
  return writes;
}

async function scheduleClock(run) {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const tasks = new Map(), callbacks = [];
  let nextId = 0;
  globalThis.setTimeout = callback => { callbacks.push(callback);tasks.set(++nextId, callback);return nextId; };
  globalThis.clearTimeout = id => tasks.delete(id);
  const flush = () => { const due = [...tasks];for (const [id, callback] of due) { tasks.delete(id);callback(); } };
  const f = undoFixture();
  const doc = f.root.ownerDocument;
  try {
    await f.ui.init();
    await run({ ...f, doc, region: doc.querySelector('[data-focus-announcer]'), flush, tasks, callbacks });
  } finally {
    await doc.defaultView.dispatch('pagehide');
    Object.assign(globalThis, original);
  }
}

const occurrenceTime = timestamp => new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
}).format(new Date(timestamp));

test('unchanged polling preserves text nodes and the focused Undo accessible name', async () => {
  const f = undoFixture();await f.ui.init();f.ui.restore.focus();
  const writes = [f.ui.status, f.ui.skipped, f.ui.restore].map(recordTextWrites);
  await f.ui.refresh();await f.ui.refresh();
  assert.deepEqual(writes, [[], [], []]);
  assert.equal(f.root.ownerDocument.activeElement, f.ui.restore);
});

test('retained markup gains one empty atomic status outside the collapsed schedule and pending subtree', () => scheduleClock(({ ui, doc, region, flush }) => {
  assert.ok(region, 'an empty live region must exist before action results');
  assert.equal(region.getAttribute('role'), 'status');
  assert.equal(region.getAttribute('aria-live'), 'polite');
  assert.equal(region.getAttribute('aria-atomic'), 'true');
  assert.equal(ui.root.contains(region), false);
  assert.equal(region.getAttribute('tabindex'), null);
  assert.equal(ui.status.getAttribute('aria-live'), null);
  assert.equal(ui.notice.getAttribute('role'), null);
  flush();
  assert.equal(region.textContent, '', 'initial and passive reads stay quiet');
  assert.equal(doc.querySelectorAll('[data-focus-announcer]').length, 1);
}));

test('successful Skip announces the skipped occurrence once after pending ends; refresh stays quiet', () => scheduleClock(async ({ ui, doc, region, flush, tasks }) => {
  const target = ui.state.next;
  ui.skip.focus();
  ui.send = async () => ({ ...ui.state, revision: 2, skipped: target, restorable: target,
    next: { key: 'later', startTime: target.startTime + 86400000 } });
  await ui.mutate({ type: 'focus_schedule_skip', revision: 1, key: target.key, startTime: target.startTime });
  assert.ok(region, 'the action needs a dedicated status');
  assert.equal(region.textContent, '');
  assert.equal(ui.root.getAttribute('aria-busy'), null);
  flush();
  assert.equal(region.textContent, 'focus_schedule_skipped: ' + occurrenceTime(target.startTime));
  const writes = recordTextWrites(region);
  await ui.refresh();flush();
  assert.deepEqual(writes, []);
  assert.equal(tasks.size, 0);
  assert.equal(doc.activeElement, ui.skip);
}));

test('Undo announces its restored occurrence even when a different session is next', () => scheduleClock(async ({ ui, occurrence, region, flush }) => {
  ui.send = async () => ({ ...ui.state, revision: 2, skipped: null, restorable: null,
    next: { key: 'earlier', startTime: occurrence.startTime - 60000 } });
  await ui.mutate({ type: 'focus_schedule_restore', revision: 1, key: occurrence.key, startTime: occurrence.startTime });
  flush();
  assert.equal(region?.textContent, 'focus_schedule_restored: ' + occurrenceTime(occurrence.startTime));
}));

test('a new action cancels an obsolete pending result, including an already queued callback', () => scheduleClock(async ({ ui, occurrence, region, flush, callbacks }) => {
  ui.send = async () => ({ ...ui.state, revision: ui.state.revision + 1 });
  await ui.mutate({ type: 'focus_schedule_skip', revision: 1, startTime: occurrence.startTime });
  const obsolete = callbacks.at(-1);
  let release;
  ui.send = () => new Promise(resolve => { release = resolve; });
  const pending = ui.mutate({ type: 'focus_schedule_restore', revision: 2, startTime: occurrence.startTime });
  obsolete?.();
  assert.equal(region?.textContent, '', 'do not report Skip after Undo has started');
  release({ ...ui.state, revision: 3, skipped: null, restorable: null });await pending;
  flush();
  assert.equal(region.textContent, 'focus_schedule_restored: ' + occurrenceTime(occurrence.startTime));
}));

test('repeated validation errors remain visible and produce separate polite updates without sending a save', () => scheduleClock(async ({ ui, form, region, flush, calls, doc }) => {
  form.elements.durationMinutes.focus();
  form.elements.durationMinutes.value = '0';
  const count = calls.length;
  await ui.save();
  assert.equal(ui.notice.textContent, 'focussessioninvalidduration');
  assert.equal(region?.textContent, '');
  flush();assert.equal(region.textContent, 'focussessioninvalidduration');
  await ui.save();
  assert.equal(region.textContent, '', 'clear before repeating identical text in a later task');
  flush();assert.equal(region.textContent, 'focussessioninvalidduration');
  assert.equal(calls.length, count);
  assert.equal(doc.activeElement, form.elements.durationMinutes);
}));

test('stale Undo announces the conflict after refreshing, never a success or a replayed mutation', () => scheduleClock(async ({ ui, occurrence, region, flush }) => {
  const calls = [];
  ui.send = async input => { calls.push(input);return input.type === 'focus_schedule_get'
    ? { ...ui.state, revision: 2, skipped: null, restorable: null }
    : { success: false, code: 'schedule_changed' }; };
  await ui.mutate({ type: 'focus_schedule_restore', key: occurrence.key, revision: 1, startTime: occurrence.startTime });
  flush();
  assert.equal(region?.textContent, 'focus_schedule_action_changed');
  assert.deepEqual(calls.map(input => input.type), ['focus_schedule_restore', 'focus_schedule_get']);
}));

test('repeated background read errors do not interrupt again, but an explicit retry is announced', () => scheduleClock(async ({ ui, region, flush }) => {
  ui.send = async () => ({ success: false, code: 'unavailable' });
  await ui.refresh();flush();
  assert.equal(region?.textContent, 'errorsavingsettings');
  const writes = recordTextWrites(region);
  await ui.refresh();flush();
  assert.deepEqual(writes, []);
  await ui.save();
  assert.equal(region.textContent, '');
  flush();assert.equal(region.textContent, 'errorsavingsettings');
}));

test('passive state changes update readable summaries without unsolicited announcements', () => scheduleClock(async ({ ui, setState, occurrence, region, flush, tasks }) => {
  setState({ revision: 2, next: { key: 'new', startTime: occurrence.startTime + 86400000 } });
  await ui.refresh();flush();
  assert.equal(ui.status.textContent, 'focus_schedule_next: ' + occurrenceTime(occurrence.startTime + 86400000));
  assert.equal(region.textContent, '');
  assert.equal(tasks.size, 0);
}));

test('hidden and modal contexts retain only the latest result until they can expose the live region', () => scheduleClock(async ({ ui, doc, region, flush, tasks }) => {
  const dialog = doc.addElement('schedule-gate', 'dialog');
  const password = doc.createElement('input');dialog.appendChild(password);password.focus();
  doc.hidden = true;
  ui.showError({ code: 'invalid_focus_schedule' });flush();
  assert.equal(region.textContent, '');assert.equal(tasks.size, 0);
  dialog.setAttribute('open', '');doc.hidden = false;
  await doc.dispatch('visibilitychange');flush();
  assert.equal(region.textContent, '');assert.equal(tasks.size, 0);
  ui.showError({ code: 'schedule_changed' });
  dialog.removeAttribute('open');await doc.dispatch('close', { target: dialog });flush();
  assert.equal(region.textContent, 'focus_schedule_changed');
  assert.equal(doc.activeElement, password);
  const writes = recordTextWrites(region);
  await doc.dispatch('focusin');flush();
  assert.deepEqual(writes, [], 'visibility/focus changes do not replay a delivered message');
}));

test('a dialog appearing during the announcement delay defers delivery until it is removed', () => scheduleClock(async ({ ui, doc, region, flush, tasks }) => {
  ui.showError({ code: 'invalid_focus_schedule' });
  const dialog = doc.addElement('late-gate', 'dialog');dialog.setAttribute('open', '');
  flush();assert.equal(region.textContent, '');assert.equal(tasks.size, 0);
  dialog.remove();await doc.dispatch('focusin');flush();
  assert.equal(region.textContent, 'invalidschedule');
}));

test('Cancel clears pending validation feedback without modifying the schedule', () => scheduleClock(async ({ ui, form, root, region, flush, calls }) => {
  form.elements.durationMinutes.value = '0';await ui.save();
  root.querySelector('[data-focus-reset]').dispatchEvent({ type: 'click' });
  await settle();flush();
  assert.equal(region.textContent, '');assert.equal(ui.notice.textContent, '');
  assert.deepEqual(calls.map(input => input.type), ['focus_schedule_get', 'focus_schedule_get']);
}));

test('pagehide cancels pending announcements and removes listeners, including stale timer callbacks', () => scheduleClock(async ({ ui, doc, region, flush, tasks, callbacks }) => {
  ui.showError({ code: 'invalid_focus_schedule' });
  const obsolete = callbacks.at(-1);
  await doc.defaultView.dispatch('pagehide');
  assert.equal(tasks.size, 0);
  obsolete();ui.showError({ code: 'schedule_changed' });flush();
  assert.equal(region.textContent, '');
  for (const type of ['visibilitychange', 'focusin', 'close']) assert.deepEqual(doc.listeners.get(type), []);
  assert.deepEqual(doc.defaultView.listeners.get('pagehide'), []);
}));
