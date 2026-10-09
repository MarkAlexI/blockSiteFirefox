import test from 'node:test';
import assert from 'node:assert/strict';
import { ALARM_BATCH, assertAlarmWakeHistory } from '../e2e/native-alarm-wake.mjs';

const inactive = { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' };
const dnr = (id, reason) => ({ id, action: { type: 'redirect', redirect: { url: `moz-extension://native/blocked.html?reason=${reason}` } },
  condition: { resourceTypes: ['main_frame'] } });
function model(expired) {
  const schedule = { version: 1, enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startTime: '09:00',
    durationMinutes: expired ? 1 : 5, revision: 7, notBefore: 0, handledKeys: [], skippedKeys: [] };
  const before = { focusSession: { focusActive: true, focusEndTime: expired ? 60_000 : 180_000,
    isHardcore: !expired, focusMode: 'blacklist' }, statistics: { successfulFocusSessions: 3 },
    rules: [{ id: 21 }, { id: 22 }], ruleLists: [{ id: 'general' }], activeRuleListId: 'general',
    rulesGeneration: 8, ruleRevisions: { 21: 1 }, ruleListRevisions: { general: 2 } };
  const fixture = { when: 60_000, schedule, current: expired ? null : { key: '2026-10-09@09:00' },
    next: { startTime: 86_400_000 } };
  const cold = { ...structuredClone(before), focusSession: expired ? { ...inactive } : { ...before.focusSession },
    focusSchedule: { ...schedule, handledKeys: expired ? [] : [fixture.current.key] },
    statistics: { successfulFocusSessions: 3 + Number(expired) }, session: { __bdIdleSession: 'token' },
    dailyRuleUsage: { usageSeconds: { '21:general': 840 } }, pendingDailyUsageRemaps: [],
    dnr: expired ? [dnr(21, 'daily_limit')] : [dnr(21, 'focus'), dnr(22, 'focus')] };
  const observation = { errors: [], events: [...ALARM_BATCH].reverse().map((name, index) =>
    ({ sequence: index + 1, at: 60_000 + index, type: 'alarm', alarm: { name, scheduledTime: 60_000 } })),
    nativeAlarms: [{ name: 'start_scheduled_focus', scheduledTime: fixture.next.startTime },
      { name: 'update_scheduled_rules', scheduledTime: 120_000 },
      ...(!expired ? [{ name: 'end_focus_session', scheduledTime: before.focusSession.focusEndTime }] : [])] };
  observation.events.push(expired ? { sequence: 4, at: 60_004, type: 'storage', changes: {
    focusSession: { oldValue: before.focusSession, newValue: cold.focusSession } } } :
    { sequence: 4, at: 60_004, type: 'storage', changes: { focusSchedule: { oldValue: schedule, newValue: cold.focusSchedule } } });
  observation.events.push({ sequence: 5, at: 60_005, type: 'dnr', rules: cold.dnr });
  return { observation, cold, before, fixture, token: 'token', expired };
}

test('native alarm observation accepts both Focus states and either recorded delivery order', () => {
  for (const expired of [true, false]) {
    const value = model(expired); assertAlarmWakeHistory(value);
    value.observation.events.splice(0, 3, ...value.observation.events.slice(0, 3).reverse());
    assertAlarmWakeHistory(value);
  }
});

test('native alarm observation rejects missing, repeated, early and mismatched native deliveries', () => {
  for (const change of [
    value => value.observation.events.shift(),
    value => value.observation.events.push(value.observation.events[0]),
    value => { value.observation.events[0].at = 59_999; },
    value => { value.observation.events[0].alarm.scheduledTime = 59_000; }
  ]) {
    const value = model(true); change(value); assert.throws(() => assertAlarmWakeHistory(value), assert.AssertionError);
  }
});

test('native alarm observation rejects a transient expired activation despite a correct final snapshot', () => {
  const value = model(true);
  value.observation.events.splice(3, 0, { type: 'storage', changes: { focusSession: {
    newValue: { ...inactive, focusActive: true, focusEndTime: 61_000 } } } });
  assert.throws(() => assertAlarmWakeHistory(value), /completed once/);
});

test('native alarm observation rejects a transient overwrite of manual Focus despite a correct final snapshot', () => {
  const value = model(false);
  value.observation.events.push({ type: 'storage', changes: { focusSession: { newValue: inactive } } });
  assert.throws(() => assertAlarmWakeHistory(value), /never writes over/);
});

test('native alarm observation rejects a transient wrong applied DNR ruleset despite restored native rules', () => {
  for (const expired of [true, false]) {
    const value = model(expired);
    value.observation.events.push({ type: 'dnr', rules: expired ? [dnr(21, 'focus'), dnr(22, 'focus')] : [dnr(21, 'daily_limit')] });
    assert.throws(() => assertAlarmWakeHistory(value), /every applied native DNR/);
  }
});

test('native alarm observation rejects wrong block reasons and non-main-frame protection', () => {
  const reason = model(true); reason.cold.dnr[0].action.redirect.url = 'moz-extension://native/blocked.html?reason=focus';
  assert.throws(() => assertAlarmWakeHistory(reason), /native blocked reason/);
  const frames = model(false); frames.cold.dnr[0].condition.resourceTypes = ['sub_frame'];
  assert.throws(() => assertAlarmWakeHistory(frames), assert.AssertionError);
});

test('native alarm observation rejects repeated claims and replay of an expired occurrence', () => {
  const repeated = model(false); repeated.observation.events.push(repeated.observation.events[3]);
  assert.throws(() => assertAlarmWakeHistory(repeated), /claimed once/);
  const expired = model(true); expired.cold.focusSchedule.handledKeys.push('2026-10-09@09:00');
  assert.throws(() => assertAlarmWakeHistory(expired), /durable schedule claim/);
});

test('native alarm observation rejects a transient budget loss despite restored final counters', () => {
  const value = model(false);
  value.observation.events.push({ type: 'storage', changes: { dailyRuleUsage: { newValue: { usageSeconds: {} } } } });
  assert.throws(() => assertAlarmWakeHistory(value), /budget is preserved throughout/);
});

test('native alarm observation rejects stale completion/next-occurrence alarms and duplicate completion counts', () => {
  const stale = model(false); stale.observation.nativeAlarms.find(alarm => alarm.name === 'end_focus_session').scheduledTime = 60_000;
  assert.throws(() => assertAlarmWakeHistory(stale), /own end time/);
  const next = model(true); next.observation.nativeAlarms[0].scheduledTime = 60_000;
  assert.throws(() => assertAlarmWakeHistory(next), /next genuine occurrence/);
  const completed = model(true); completed.cold.statistics.successfulFocusSessions++;
  assert.throws(() => assertAlarmWakeHistory(completed), /counted exactly once/);
});

test('native alarm observation rejects lost observer history, session and rule metadata', () => {
  const error = model(true); error.observation.errors.push('native backend read failed');
  assert.throws(() => assertAlarmWakeHistory(error), /did not lose history/);
  const session = model(false); session.cold.session = {};
  assert.throws(() => assertAlarmWakeHistory(session), /session survived/);
  const revision = model(false); revision.cold.rulesGeneration++;
  assert.throws(() => assertAlarmWakeHistory(revision), /rulesGeneration survived/);
});
