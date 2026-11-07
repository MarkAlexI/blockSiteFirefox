import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './helpers/extensionTestHarness.js';
import { FocusScheduleUI, revealFocusSchedule } from '../schedules/focusScheduleUI.js';

function fixture({ withRestore = true } = {}) {
  const doc = new FakeDocument();
  const root = doc.createElement('details');
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
  f.ui.restore.focus();let release;const calls = [];
  f.ui.send = input => { calls.push(input);return new Promise(resolve => { release = resolve; }); };
  f.ui.restore.dispatchEvent({ type: 'click' });f.ui.restore.dispatchEvent({ type: 'click' });
  assert.equal(calls.length, 1);
  assert.equal(f.ui.skip.disabled, true);assert.equal(f.ui.restore.disabled, true);
  release({ ...f.ui.state, success: true, revision: 2, restorable: null, skipped: null });
  await settle();
  assert.equal(f.ui.busy, false);assert.equal(f.ui.restore.hidden, true);
  assert.equal(f.root.ownerDocument.activeElement, f.ui.skip);
  assert.deepEqual(f.root.ownerDocument.listeners.get('focusin'), []);
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
