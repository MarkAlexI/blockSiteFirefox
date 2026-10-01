import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './helpers/extensionTestHarness.js';
import { FocusScheduleUI, revealFocusSchedule } from '../schedules/focusScheduleUI.js';

function fixture() {
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
  for (const name of ['status','skipped','notice','skip','access','reset']) {
    const el = doc.createElement(name === 'skip' || name === 'reset' ? 'button' : 'p');
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
