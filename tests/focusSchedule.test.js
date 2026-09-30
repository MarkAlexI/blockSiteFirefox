import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFocusSchedule, validateFocusSchedule, readFocusSchedule, focusOccurrences, nextFocusOccurrence } from '../schedules/focusSchedule.js';
import { createFocusScheduleController } from '../schedules/focusScheduleController.js';

const instant = (hour, minute = 0, day = 28) => new Date(2026, 8, day, hour, minute).getTime();
const schedule = (extra = {}) => ({ ...defaultFocusSchedule(), enabled: true, durationMinutes: 50, ...extra });
const config = state => Object.fromEntries(['enabled', 'days', 'startTime', 'durationMinutes'].map(key => [key, state[key]]));

function fixture(state = schedule(), time = instant(9, 20), access = { isPro: true }) {
  const data = { focusSchedule: structuredClone(state) };
  const alarmMap = new Map();
  const starts = [];
  let clock = time;
  let session = { focusActive: false };
  let tail = Promise.resolve();
  const storage = { get: async () => structuredClone(data), set: async values => Object.assign(data, structuredClone(values)) };
  const alarms = { get: async key => alarmMap.get(key), clear: async key => alarmMap.delete(key), create: async (key, value) => alarmMap.set(key, value) };
  const dependencies = { storage, alarms, getAccess: async () => access, getSession: async () => session,
    startSession: async occurrence => { starts.push(occurrence); session = { focusActive: true }; return true; },
    runExclusive: operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next; },
    now: () => clock };
  return { controller: createFocusScheduleController(dependencies), data, alarmMap, starts, access, storage,
    setTime: value => { clock = value; }, setSession: value => { session = value; },
    restart: () => createFocusScheduleController(dependencies) };
}

test('existing installations and corrupt/future schedules stay disabled', () => {
  for (const input of [undefined, null, {}, { version: 2, enabled: true }, { ...schedule(), days: [] }]) {
    assert.equal(readFocusSchedule(input).enabled, false);
  }
});

test('schedule messages reject unknown fields, invalid days/times/durations', () => {
  for (const change of [{ days: [] }, { days: [1,1] }, { days: [7] }, { days: ['1'] },
    { enabled: 'true' }, { startTime: '24:00' }, { startTime: '9:00' }, { startTime: '10:60' },
    { durationMinutes: 0 }, { durationMinutes: 241 }, { durationMinutes: 1.5 }, { durationMinutes: '25' }, { isHardcore: true }]) {
    assert.throws(() => validateFocusSchedule({ ...config(schedule()), ...change }), { code: 'invalid_focus_schedule' });
  }
});

test('late wake uses the original end; a completely missed window is not replayed', () => {
  assert.equal(nextFocusOccurrence(schedule(), instant(9,20)).endTime, instant(9,50));
  assert.equal(nextFocusOccurrence(schedule(), instant(10)).startTime, instant(9,0,29));
});

test('overnight session belongs to its start day, including across month end', () => {
  const state = schedule({ days: [3], startTime: '23:30', durationMinutes: 120 });
  const next = nextFocusOccurrence(state, new Date(2026,9,1,0,15).getTime());
  assert.equal(next.key, '2026-09-30@23:30');
  assert.equal(next.endTime, new Date(2026,9,1,1,30).getTime());
});

test('32 skipped weekly occurrences still leave a next launch', () => {
  const state = schedule({ days: [1] });
  state.skippedKeys = focusOccurrences(state, instant(8)).slice(0,32).map(item => item.key);
  assert.ok(nextFocusOccurrence(state, instant(8)));
});

test('DST skips nonexistent start times and repeats a fall-back wall time only once', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const spring = schedule({ days: [0], startTime: '02:30' });
    assert.equal(nextFocusOccurrence(spring, new Date(2026,2,8,0).getTime()).key, '2026-03-15@02:30');
    const fall = schedule({ days: [0], startTime: '01:30', durationMinutes: 120 });
    const first = nextFocusOccurrence(fall, new Date('2026-11-01T05:35:00Z').getTime());
    const second = nextFocusOccurrence(fall, new Date('2026-11-01T06:35:00Z').getTime());
    assert.equal(first.key, second.key);
    assert.equal(first.startTime, second.startTime);
    assert.equal(first.endTime - first.startTime, 120 * 60_000);
    fall.handledKeys.push(first.key);
    assert.equal(nextFocusOccurrence(fall, new Date('2026-11-01T06:35:00Z').getTime()).key, '2026-11-08@01:30');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('timezone changes recompute local starts without repeating an already handled day', async () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Kyiv';
  try {
    const f = fixture(schedule(), new Date('2026-09-28T06:20:00Z').getTime());
    await f.controller.reconcile();
    assert.equal(f.starts.length, 1);
    process.env.TZ = 'Europe/London';
    f.setTime(new Date('2026-09-28T08:20:00Z').getTime());
    f.setSession({ focusActive: false });
    await f.controller.reconcile();
    assert.equal(f.starts.length, 1);
    assert.equal(f.alarmMap.get('start_scheduled_focus').when, new Date('2026-09-29T08:00:00Z').getTime());
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('alarm races and a worker restart cannot duplicate a scheduled session', async () => {
  const f = fixture();
  await Promise.all([f.controller.reconcile(),f.controller.reconcile(),f.controller.reconcile()]);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].endTime, instant(9,50));
  f.setSession({ focusActive: false });
  f.alarmMap.clear();
  await f.restart().reconcile();
  assert.equal(f.starts.length, 1);
  assert.equal(f.alarmMap.get('start_scheduled_focus').when, instant(9,0,29));
});

test('manual session wins and manual stop suppresses the active scheduled window', async () => {
  const f = fixture();
  f.setSession({ focusActive: true });
  assert.equal((await f.controller.reconcile()).status, 'manual_priority');
  f.setSession({ focusActive: false });
  await f.controller.reconcile();
  assert.equal(f.starts.length, 0);
  const g = fixture();
  await g.controller.suppressCurrent();
  await g.controller.reconcile();
  assert.equal(g.starts.length, 0);
});

test('skip persists across restart but does not turn off the recurring schedule', async () => {
  const f = fixture(schedule(), instant(8));
  const state = await f.controller.status();
  await f.controller.skip(state.next.key);
  f.setTime(instant(9,20));
  await f.restart().reconcile();
  assert.equal(f.starts.length, 0);
  assert.equal(f.data.focusSchedule.enabled, true);
  f.setTime(instant(9,20,29));
  await f.controller.reconcile();
  assert.equal(f.starts.length, 1);
});

test('enabling/editing does not unexpectedly begin a session already in progress', async () => {
  const f = fixture(defaultFocusSchedule());
  await f.controller.save(config(schedule()), 0);
  await f.controller.reconcile();
  assert.equal(f.starts.length, 0);
  assert.equal((await f.controller.status()).next.startTime, instant(9,0,29));
});

test('an old editor cannot silently overwrite newer schedule settings', async () => {
  const f = fixture();
  await f.controller.save({ ...config(schedule()), durationMinutes: 60 }, 0);
  await assert.rejects(f.controller.save(config(schedule()), 0), { code: 'schedule_changed' });
  assert.equal(f.data.focusSchedule.durationMinutes, 60);
});

test('lost access skips a window; restored access does not replay it; disabling remains possible', async () => {
  const f = fixture(schedule(), instant(9,20), { isPro: false, isLegacyUser: false });
  await assert.rejects(f.controller.save(config(schedule()), 0), { code: 'pro_required' });
  assert.equal((await f.controller.reconcile()).status, 'pro_required');
  f.access.isPro = true;
  await f.controller.reconcile();
  assert.equal(f.starts.length, 0);
  f.access.isPro = false;
  await f.controller.save({ ...config(schedule()), enabled: false }, 0);
  assert.equal(f.alarmMap.size, 0);
});

test('Legacy access can save and start a schedule', async () => {
  const f = fixture(schedule(), instant(9,20), { isPro: false, isLegacyUser: true });
  await f.controller.save(config(schedule()), 0);
  await f.controller.reconcile();
  assert.equal(f.starts.length, 1);
});

test('failure to persist the occurrence claim must not start any blocking', async () => {
  const f = fixture();
  f.storage.set = async () => { throw new Error('storage failed'); };
  await assert.rejects(f.controller.reconcile(), /storage failed/);
  assert.equal(f.starts.length, 0);
});
