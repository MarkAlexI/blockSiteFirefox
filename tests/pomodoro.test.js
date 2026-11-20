import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
const { DEFAULT_POMODORO, normalizePomodoroConfig, readPomodoro, startPomodoro,
  matchesPomodoroWork, completePomodoroWork, nextPomodoroWork, getPomodoroDurationMs, hardenPomodoro, isPomodoroHardcoreLocked, getFocusSessionLockState } = await withExtensionEnvironment(
  createExtensionApi(), () => import('../utils/focusSession.js'));

const id = '00000000-0000-4000-8000-000000000001';
const at = Date.parse('2026-11-20T09:00:00Z');
const start = (config = {}) => startPomodoro(normalizePomodoroConfig(config), at, id);

test('Free has a complete manual 25/5 cycle while automatic continuation requires Pro', () => {
  assert.deepEqual(normalizePomodoroConfig({}, {}), DEFAULT_POMODORO);
  assert.equal(normalizePomodoroConfig({ autoContinue: true }, { isPro: true }).autoContinue, true);
  for (const config of [{ workMinutes: 26 }, { breakMinutes: 6 }, { rounds: 8 },
    { longBreakMinutes: 20 }, { isHardcore: true }, { focusMode: 'whitelist' }, { autoContinue: true }]) {
    assert.throws(() => normalizePomodoroConfig(config, {}), { code: 'pro_required' });
    assert.doesNotThrow(() => normalizePomodoroConfig(config, { isLegacyUser: true }));
  }
});

test('invalid durations, modes and untrusted extra fields are rejected', () => {
  for (const config of [{ rounds: 0 }, { rounds: 13 }, { workMinutes: 0 }, { breakMinutes: 241 },
    { rounds: '4' }, { workMinutes: 1.5 }, { longBreakMinutes: NaN }, { focusMode: 'all' },
    { autoContinue: 1 }, { phaseEndTime: at }, [], null]) {
    assert.throws(() => normalizePomodoroConfig(config), { code: 'invalid_pomodoro' });
  }
});

test('work completion gives the remainder of the real break without altering its deadline', () => {
  const cycle = start();
  const next = completePomodoroWork(cycle, cycle.phaseEndTime + 60_000);
  assert.equal(next.phase, 'break');
  assert.equal(next.completedRounds, 1);
  assert.equal(next.phaseEndTime, cycle.phaseEndTime + 5 * 60_000);
  assert.deepEqual(readPomodoro(next), next);
});

test('a long suspension expires Hardcore without inventing later work', () => {
  const cycle = start({ autoContinue: true, isHardcore: true });
  const next = completePomodoroWork(cycle, at + 8 * 3600_000);
  assert.equal(next, null);
});

test('every fourth completed interval selects a long break only if another interval remains', () => {
  let cycle = start({ rounds: 8, longBreakMinutes: 20 });
  for (let completed = 1; completed <= 8; completed++) {
    const end = cycle.phaseEndTime;
    const next = completePomodoroWork(cycle, end);
    if (completed === 8) { assert.equal(next, null); break; }
    assert.equal(next.completedRounds, completed);
    assert.equal(next.phaseEndTime - end, (completed % 4 ? 5 : 20) * 60_000);
    cycle = nextPomodoroWork(next, next.phaseEndTime);
  }
});

test('manual continuation creates a full interval from now, even after a long absence', () => {
  const cycle = completePomodoroWork(start(), at + 10 * 3600_000);
  const next = nextPomodoroWork(cycle, at + 11 * 3600_000);
  assert.equal(next.phase, 'work');
  assert.equal(next.completedRounds, 1);
  assert.equal(next.phaseEndTime, at + 11 * 3600_000 + 25 * 60_000);
  assert.equal(next.id, id);
});

test('only the matching stored work interval can advance a cycle', () => {
  const cycle = start();
  const focus = { focusActive: true, pomodoroId: id, focusEndTime: cycle.phaseEndTime };
  assert.equal(matchesPomodoroWork(cycle, focus), true);
  for (const patch of [{ pomodoroId: 'another' }, { focusEndTime: focus.focusEndTime + 1 }, { focusActive: false }]) {
    assert.equal(matchesPomodoroWork(cycle, { ...focus, ...patch }), false);
  }
});

test('corrupt stored cycles cannot strand normal Focus or bypass configuration limits', () => {
  const cycle = start();
  for (const patch of [{ phase: 'pause' }, { completedRounds: 4 }, { completedRounds: -1 },
    { rounds: 0 }, { phaseEndTime: '123' }, { id: '' }, { schemaVersion: 2 },
    { phase: 'break', completedRounds: 0 }, { phase: 'ready', phaseEndTime: 1 }]) {
    assert.equal(readPomodoro({ ...cycle, ...patch }), null);
  }
});


test('Hardcore forces automatic continuation for Pro and Legacy but cannot grant Free access', () => {
  for (const access of [{ isPro: true }, { isLegacyUser: true }]) {
    assert.equal(normalizePomodoroConfig({ isHardcore: true, autoContinue: false }, access).autoContinue, true);
  }
  assert.throws(() => normalizePomodoroConfig({ isHardcore: true }, {}), { code: 'pro_required' });
});

test('total duration excludes a final break and includes long breaks only between rounds', () => {
  assert.equal(getPomodoroDurationMs(normalizePomodoroConfig({ rounds: 1 })), 25 * 60_000);
  assert.equal(getPomodoroDurationMs(DEFAULT_POMODORO), 115 * 60_000);
  assert.equal(getPomodoroDurationMs(normalizePomodoroConfig({ rounds: 8, longBreakMinutes: 20 })), 250 * 60_000);
  assert.equal(getPomodoroDurationMs(normalizePomodoroConfig({ rounds: 12, workMinutes: 240, breakMinutes: 240, longBreakMinutes: 240 })), 5520 * 60_000);
});

test('Hardcore stores one deadline and continuation cannot extend it', () => {
  const cycle = start({ isHardcore: true });
  const end = at + 115 * 60_000;
  assert.equal(cycle.hardcoreEndTime, end);
  assert.deepEqual(readPomodoro(cycle), cycle);
  const rest = completePomodoroWork(cycle, cycle.phaseEndTime);
  const next = nextPomodoroWork(rest, end - 30_000);
  assert.equal(next.hardcoreEndTime, end);
  assert.equal(next.phaseEndTime, end);
  assert.equal(next.workStartedAt, end - 30_000);
  assert.equal(isPomodoroHardcoreLocked(next, end - 1), true);
  assert.equal(isPomodoroHardcoreLocked(next, end), false);
});

test('unpublished Hardcore state upgrades once from work, break or waiting', () => {
  const current = start({ isHardcore: true });
  const { hardcoreEndTime, workStartedAt, ...legacy } = current;
  const migrated = hardenPomodoro(readPomodoro({ ...legacy, autoContinue: false }), at + 1000);
  assert.equal(migrated.hardcoreEndTime, hardcoreEndTime);
  assert.equal(migrated.autoContinue, true);
  assert.deepEqual(hardenPomodoro(migrated, at + 8 * 3600_000), migrated);
  for (const phase of ['break', 'ready']) {
    const old = { ...legacy, phase, completedRounds: 1, phaseEndTime: phase === 'break' ? at + 30 * 60_000 : 0 };
    const fixed = hardenPomodoro(readPomodoro(old), at + 30 * 60_000);
    assert.equal(fixed.hardcoreEndTime, hardcoreEndTime);
    assert.deepEqual(hardenPomodoro(fixed, at + 1_000_000), fixed);
  }
});

test('normal Pomodoro remains manual and has no Hardcore deadline', () => {
  const cycle = start();
  assert.equal(cycle.hardcoreEndTime, undefined);
  assert.equal(isPomodoroHardcoreLocked(cycle, at), false);
  assert.equal(hardenPomodoro(cycle, at), cycle);
});

test('Options can lock editing during a Hardcore break without reactivating blocking', async () => {
  const cycle = { ...start({ isHardcore: true }), phase: 'break', completedRounds: 1, phaseEndTime: at + 30 * 60_000 };
  const api = createExtensionApi({ local: { focusSession: { focusActive: false }, pomodoroSession: cycle } });
  const realNow = Date.now;
  Date.now = () => at + 26 * 60_000;
  try {
    await withExtensionEnvironment(api, async () => {
      const lock = await getFocusSessionLockState({ throwOnError: true });
      assert.equal(lock.focusActive, true);
      assert.equal(lock.focusEndTime, cycle.hardcoreEndTime);
      assert.equal(api.storage.local.data.focusSession.focusActive, false);
    });
  } finally { Date.now = realNow; }
});

test('skipping a Hardcore break can shorten the deadline but can never postpone it', () => {
  const cycle = start({ isHardcore: true });
  const rest = completePomodoroWork(cycle, cycle.phaseEndTime);
  const next = nextPomodoroWork(rest, rest.phaseEndTime - 3 * 60_000);
  assert.equal(next.hardcoreEndTime, cycle.hardcoreEndTime - 3 * 60_000);
  assert.equal(next.phaseEndTime - next.workStartedAt, 25 * 60_000);
});


test('invalid Hardcore timestamps cannot reach the deadline formatter or native alarms', () => {
  const cycle = start({ isHardcore: true });
  for (const value of [NaN, Infinity, -1, 1e100, 1.5]) {
    assert.equal(readPomodoro({ ...cycle, hardcoreEndTime: value }), null);
    assert.equal(readPomodoro({ ...cycle, workStartedAt: value }), null);
  }
});
