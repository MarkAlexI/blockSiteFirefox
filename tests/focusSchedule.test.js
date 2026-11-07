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
  return { controller: createFocusScheduleController(dependencies), data, alarmMap, starts, access, storage, dependencies,
    setTime: value => { clock = value; }, setSession: value => { session = value; },
    restart: () => createFocusScheduleController(dependencies) };
}

test('restore returns only the selected future session to its original alarm and survives restart', async () => {
  const f = fixture(schedule(), instant(8));
  const original = await f.controller.status();
  const skipped = await f.controller.skip(original.next.key, original.revision, original.next.startTime);
  assert.equal(skipped.revision, original.revision + 1);
  assert.deepEqual(skipped.restorable, original.next);
  const restored = await f.restart().restore(skipped.restorable.key, skipped.revision, skipped.restorable.startTime);
  assert.equal(restored.revision, skipped.revision + 1);
  assert.deepEqual(restored.next, original.next);
  assert.equal(restored.restorable, null);
  assert.deepEqual(f.data.focusSchedule.skippedKeys, []);
  assert.deepEqual(restored.config, original.config);
  assert.equal(f.alarmMap.get('start_scheduled_focus').when, original.next.startTime);
  await f.restart().reconcile();
  assert.equal(f.starts.length, 0);
  f.setTime(instant(9,20));
  await Promise.all([f.restart().reconcile(), f.restart().reconcile()]);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].endTime, original.next.endTime);
});

test('restore preserves other skips and the recurring configuration', async () => {
  const f = fixture(schedule(), instant(8));
  const initial = await f.controller.status();
  const first = await f.controller.skip(initial.next.key, initial.revision, initial.next.startTime);
  const second = await f.controller.skip(first.next.key, first.revision, first.next.startTime);
  const result = await f.controller.restore(initial.next.key, second.revision, initial.next.startTime);
  assert.deepEqual(f.data.focusSchedule.skippedKeys, [first.next.key]);
  assert.deepEqual(result.next, initial.next);
  assert.equal(result.restorable.key, first.next.key);
  assert.deepEqual(result.config, initial.config);
});

for (const at of [instant(9), instant(9,20), instant(10)]) {
  test(`restore cannot revive a session at or after its start: ${at}`, async () => {
    const f = fixture(schedule(), instant(8));
    const shown = await f.controller.status();
    const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
    f.setTime(at);
    const before = structuredClone(f.data);
    assert.equal((await f.controller.status()).restorable, null);
    await assert.rejects(f.controller.restore(shown.next.key, skipped.revision, shown.next.startTime), { code: 'schedule_changed' });
    assert.deepEqual(f.data, before);
    assert.equal(f.starts.length, 0);
  });
}

test('restore rejects incomplete or stale displayed tokens without writing', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
  const before = structuredClone(f.data);
  for (const args of [[], [shown.next.key], [shown.next.key, skipped.revision],
    [shown.next.key, skipped.revision, String(shown.next.startTime)],
    [shown.next.key, shown.revision, shown.next.startTime],
    ['another-key', skipped.revision, shown.next.startTime]]) {
    await assert.rejects(f.controller.restore(...args), { code: 'schedule_changed' });
  }
  assert.deepEqual(f.data, before);
});

test('restore serializes duplicate requests and rejects an older Undo after restore and reskip', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
  const token = [shown.next.key, skipped.revision, shown.next.startTime];
  const results = await Promise.allSettled([f.controller.restore(...token), f.controller.restore(...token)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'schedule_changed');
  const restored = await f.controller.status();
  await f.controller.skip(shown.next.key, restored.revision, shown.next.startTime);
  const before = structuredClone(f.data);
  await assert.rejects(f.restart().restore(...token), { code: 'schedule_changed' });
  assert.deepEqual(f.data, before);
});

test('restore rejects an occurrence removed by a settings edit', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
  await f.controller.save({ ...skipped.config, startTime: '10:00' }, skipped.revision);
  const before = structuredClone(f.data);
  await assert.rejects(f.controller.restore(shown.next.key, skipped.revision, shown.next.startTime), { code: 'schedule_changed' });
  assert.deepEqual(f.data, before);
});

test('restore requires current paid access and accepts Legacy access', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
  f.access.isPro = false;
  const before = structuredClone(f.data);
  await assert.rejects(f.controller.restore(shown.next.key, skipped.revision, shown.next.startTime), { code: 'pro_required' });
  assert.deepEqual(f.data, before);
  f.access.isLegacyUser = true;
  assert.deepEqual((await f.controller.restore(shown.next.key, skipped.revision, shown.next.startTime)).next, shown.next);
});

for (const change of ['clock', 'timezone']) {
  test(`restore revalidates the ${change} after an asynchronous access lookup`, async () => {
    const previous = process.env.TZ;
    let release;
    try {
      process.env.TZ = 'Europe/London';
      const f = fixture(schedule(), Date.parse('2026-09-28T07:00:00Z'));
      const shown = await f.controller.status();
      const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
      const before = structuredClone(f.data);
      let entered;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      f.dependencies.getAccess = async () => { entered(); await gate; return f.access; };
      const rejected = assert.rejects(f.restart().restore(shown.next.key, skipped.revision, shown.next.startTime), { code: 'schedule_changed' });
      await ready;
      if (change === 'clock') f.setTime(shown.next.startTime);
      else process.env.TZ = 'America/New_York';
      release();await rejected;
      assert.deepEqual(f.data, before);
    } finally { release?.(); if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
}

test('restore storage failure leaves the original skip durable and permits a later retry', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
  const before = structuredClone(f.data);
  const write = f.storage.set;
  f.storage.set = async () => { throw new Error('storage failed'); };
  await assert.rejects(f.controller.restore(shown.next.key, skipped.revision, shown.next.startTime), /storage failed/);
  assert.deepEqual(f.data, before);
  f.storage.set = write;
  await f.restart().restore(shown.next.key, skipped.revision, shown.next.startTime);
  assert.deepEqual(f.data.focusSchedule.skippedKeys, []);
});

test('restore never resurrects a handled occurrence after a clock rollback', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
  f.data.focusSchedule.handledKeys = [shown.next.key];
  assert.equal((await f.controller.status()).restorable, null);
  await assert.rejects(f.controller.restore(shown.next.key, skipped.revision, shown.next.startTime), { code: 'schedule_changed' });
});

test('restore keeps its durable result after alarm failure and restart repairs the original deadline', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  const skipped = await f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
  const create = f.dependencies.alarms.create;
  f.dependencies.alarms.create = async () => { throw new Error('alarm failed'); };
  await assert.rejects(f.controller.restore(shown.next.key, skipped.revision, shown.next.startTime), /alarm failed/);
  assert.deepEqual(f.data.focusSchedule.skippedKeys, []);
  assert.equal(f.data.focusSchedule.revision, skipped.revision + 1);
  f.dependencies.alarms.create = create;
  await f.restart().reconcile();
  assert.equal(f.alarmMap.get('start_scheduled_focus').when, shown.next.startTime);
  assert.equal(f.starts.length, 0);
  await assert.rejects(f.restart().restore(shown.next.key, skipped.revision, shown.next.startTime), { code: 'schedule_changed' });
});

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
  await f.controller.skip(state.next.key, state.revision, state.next.startTime);
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

for (const method of ['get', 'create']) {
  test(`next schedule alarm ${method} failure cannot consume the current Focus start`, async () => {
    const f = fixture();
    const alarmError = new Error(`next alarm ${method} failed`);
    const original = f.dependencies.alarms[method];
    f.dependencies.alarms[method] = async () => { throw alarmError; };
    await assert.rejects(f.controller.reconcile(), error => error === alarmError);
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].endTime, instant(9,50));
    assert.deepEqual(f.data.focusSchedule.handledKeys, ['2026-09-28@09:00']);
    f.dependencies.alarms[method] = original;
    await Promise.all([f.restart().reconcile(), f.restart().reconcile()]);
    assert.equal(f.starts.length, 1);
    assert.equal(f.alarmMap.get('start_scheduled_focus').when, instant(9,0,29));
  });
}

test('a delayed next alarm cannot hold activation until the current window expires', { timeout: 2000 }, async () => {
  const f = fixture();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const create = f.dependencies.alarms.create;
  f.dependencies.alarms.create = async (...args) => { entered(); await gate; return create(...args); };
  const pending = f.controller.reconcile();
  try {
    await ready;
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].endTime, instant(9,50));
  } finally {
    f.setTime(instant(10));
    release();
    await pending;
  }
  assert.equal(f.starts.length, 1);
});

test('a next alarm failure cannot replace the original activation error', async () => {
  const f = fixture();
  const activationError = new Error('activation failed');
  const alarmError = new Error('next alarm failed');
  let activations = 0, arms = 0;
  f.dependencies.startSession = async () => { activations++; throw activationError; };
  f.dependencies.alarms.create = async () => { arms++; throw alarmError; };
  await assert.rejects(f.restart().reconcile(), error => error === activationError);
  assert.equal(activations, 1);
  assert.equal(arms, 1);
  assert.deepEqual(f.data.focusSchedule.handledKeys, ['2026-09-28@09:00']);
});

for (const guard of ['pro_required', 'manual_priority']) {
  test(`next alarm failure preserves the ${guard} activation guard`, async () => {
    const f = fixture();
    if (guard === 'pro_required') f.access.isPro = false;
    else f.setSession({ focusActive: true });
    const alarmError = new Error('next alarm failed');
    const create = f.dependencies.alarms.create;
    f.dependencies.alarms.create = async () => { throw alarmError; };
    await assert.rejects(f.controller.reconcile(), error => error === alarmError);
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.data.focusSchedule.handledKeys, ['2026-09-28@09:00']);
    f.dependencies.alarms.create = create;
    f.access.isPro = true;
    f.setSession({ focusActive: false });
    await f.restart().reconcile();
    assert.equal(f.starts.length, 0);
    assert.equal(f.alarmMap.get('start_scheduled_focus').when, instant(9,0,29));
  });
}

for (const first of ['skip', 'alarm']) {
  test(`Skip and a due alarm serialize when ${first} holds the durable write`, { timeout: 2000 }, async () => {
    const f = fixture(schedule(), instant(8));
    const shown = await f.controller.status();
    f.setTime(instant(9,20));
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const write = f.storage.set;
    let paused = false;
    f.storage.set = async value => {
      if (!paused) { paused = true; entered(); await gate; }
      return write(value);
    };
    const skip = () => f.controller.skip(shown.next.key, shown.revision, shown.next.startTime);
    const pending = first === 'skip' ? skip() : f.controller.reconcile();
    let second;
    try {
      await ready;
      second = first === 'skip' ? f.controller.reconcile()
        : assert.rejects(skip(), { code: 'schedule_changed' });
    } finally { release(); }
    await Promise.all([pending, second]);
    assert.equal(f.starts.length, first === 'skip' ? 0 : 1);
    assert.deepEqual(f.data.focusSchedule.skippedKeys, first === 'skip' ? [shown.next.key] : []);
    assert.deepEqual(f.data.focusSchedule.handledKeys, first === 'alarm' ? [shown.next.key] : []);
    await f.restart().reconcile();
    assert.equal(f.starts.length, first === 'skip' ? 0 : 1);
  });
}

test('failure to persist the occurrence claim must not start any blocking', async () => {
  const f = fixture();
  f.storage.set = async () => { throw new Error('storage failed'); };
  await assert.rejects(f.controller.reconcile(), /storage failed/);
  assert.equal(f.starts.length, 0);
});

test('stale intent: skip cannot consume a session edited in another Options window', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  await f.controller.save({ ...shown.config, durationMinutes: 60 }, shown.revision);
  const before = structuredClone(f.data);
  await assert.rejects(f.controller.skip(shown.next.key, shown.revision, shown.next.startTime), { code: 'schedule_changed' });
  assert.deepEqual(f.data, before);
  const fresh = await f.controller.status();
  await f.controller.skip(fresh.next.key, fresh.revision, fresh.next.startTime);
  assert.deepEqual(f.data.focusSchedule.skippedKeys, [fresh.next.key]);
});

test('stale intent: skip rejects the same local key after a timezone change', async () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const f = fixture(schedule(), Date.parse('2026-09-28T00:00:00Z'));
    const shown = await f.controller.status();
    process.env.TZ = 'Europe/London';
    const fresh = await f.controller.status();
    assert.equal(fresh.next.key, shown.next.key);
    assert.notEqual(fresh.next.startTime, shown.next.startTime);
    const before = structuredClone(f.data);
    await assert.rejects(f.controller.skip(shown.next.key, shown.revision, shown.next.startTime), { code: 'schedule_changed' });
    assert.deepEqual(f.data, before);
    await f.controller.skip(fresh.next.key, fresh.revision, fresh.next.startTime);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('stale intent: automatic start rechecks a clock rollback across an awaited access read', { timeout: 2000 }, async () => {
  const f = fixture();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.dependencies.getAccess = async () => { entered(); await gate; return f.access; };
  const pending = f.restart().reconcile();
  try { await ready; f.setTime(instant(8)); }
  finally { release(); }
  await pending;
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.data.focusSchedule.handledKeys, []);
  assert.equal(f.alarmMap.get('start_scheduled_focus').when, instant(9));
});

test('stale intent: a queued skip checks the committed revision after another window saves', { timeout: 2000 }, async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const write = f.storage.set;
  f.storage.set = async value => { entered(); await gate; return write(value); };
  const saved = f.controller.save({ ...shown.config, durationMinutes: 60 }, shown.revision);
  let rejected;
  try {
    await ready;
    rejected = assert.rejects(f.controller.skip(shown.next.key, shown.revision, shown.next.startTime), { code: 'schedule_changed' });
  } finally { release(); }
  await saved;
  await rejected;
  assert.equal(f.data.focusSchedule.durationMinutes, 60);
  assert.deepEqual(f.data.focusSchedule.skippedKeys, []);
});

test('stale intent: schedule A-to-B-to-A and worker restart do not revive an old Skip', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  const changed = await f.controller.save({ ...shown.config, durationMinutes: 60 }, shown.revision);
  await f.controller.save(shown.config, changed.revision);
  await assert.rejects(f.restart().skip(shown.next.key, shown.revision, shown.next.startTime), { code: 'schedule_changed' });
  assert.deepEqual(f.data.focusSchedule.skippedKeys, []);
});

test('stale intent: a timezone change during access lookup rearms without claiming the old local start', { timeout: 2000 }, async () => {
  const previous = process.env.TZ;
  let release;
  try {
    process.env.TZ = 'Europe/London';
    const f = fixture(schedule(), Date.parse('2026-09-28T08:20:00Z'));
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    f.dependencies.getAccess = async () => { entered(); await gate; return f.access; };
    const pending = f.restart().reconcile();
    try { await ready; process.env.TZ = 'America/New_York'; }
    finally { release(); }
    await pending;
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.data.focusSchedule.handledKeys, []);
    assert.equal(f.alarmMap.get('start_scheduled_focus').when, Date.parse('2026-09-28T13:00:00Z'));
  } finally {
    release?.();
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('stale intent: skip requires a complete displayed occurrence token', async () => {
  const f = fixture(schedule(), instant(8));
  const shown = await f.controller.status();
  for (const args of [[shown.next.key], [shown.next.key, shown.revision],
    [shown.next.key, shown.revision, String(shown.next.startTime)]]) {
    await assert.rejects(f.controller.skip(...args), { code: 'schedule_changed' });
  }
  assert.deepEqual(f.data.focusSchedule.skippedKeys, []);
});

for (const change of ['clock', 'timezone']) {
  test(`stale intent: ${change} change during the durable claim prevents activation of the old window`, { timeout: 2000 }, async () => {
    const previous = process.env.TZ;
    let release;
    try {
      process.env.TZ = 'Europe/London';
      const f = fixture(schedule(), Date.parse('2026-09-28T08:20:00Z'));
      let entered;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const write = f.storage.set;
      f.storage.set = async value => { entered(); await gate; return write(value); };
      const pending = f.controller.reconcile();
      try {
        await ready;
        if (change === 'clock') f.setTime(Date.parse('2026-09-28T07:00:00Z'));
        else process.env.TZ = 'America/New_York';
      } finally { release(); }
      await pending;
      assert.equal(f.starts.length, 0);
      // Keep the durable at-most-once claim, including after a worker restart.
      assert.deepEqual(f.data.focusSchedule.handledKeys, ['2026-09-28@09:00']);
      f.setTime(Date.parse('2026-09-28T13:20:00Z'));
      await f.restart().reconcile();
      assert.equal(f.starts.length, 0);
    } finally {
      release?.();
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });
}
