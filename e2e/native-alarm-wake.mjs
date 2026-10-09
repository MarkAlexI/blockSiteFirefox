import assert from 'node:assert/strict';

export const ALARM_BATCH = ['end_focus_session', 'start_scheduled_focus', 'update_scheduled_rules'];
const ids = rules => rules.map(rule => rule.id).sort((a, b) => a - b);
const reason = rule => new URL(rule.action.redirect.url).searchParams.get('reason');
export function assertAlarmWakeHistory({ observation, cold, before, fixture, token, expired }) {
  assert.deepEqual(observation.errors, [], 'native observers did not lose history');
  const deliveries = observation.events.filter(event => event.type === 'alarm');
  assert.deepEqual(deliveries.map(event => event.alarm.name).sort(), ALARM_BATCH,
    'all three real alarms delivered exactly once, in the recorded browser order');
  for (const event of deliveries) {
    assert.equal(event.alarm.scheduledTime, fixture.when, 'native batch has one scheduled time');
    assert.ok(event.at >= fixture.when, 'native alarm was not delivered early');
  }
  const focusWrites = observation.events.filter(event => event.type === 'storage' && event.changes.focusSession);
  if (expired) {
    assert.equal(focusWrites.length, 1, 'expired Focus completed once');
    assert.deepEqual(focusWrites[0].changes.focusSession.newValue,
      { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' },
      'no transient activation of the expired occurrence');
  } else {
    assert.deepEqual(focusWrites, [], 'stale completion never writes over the newer manual Focus');
  }
  assert.deepEqual(cold.focusSession, expired ?
    { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' } : before.focusSession,
  'cold Focus state is correct before any UI intent');
  const expectedIds = expired ? [21] : [21, 22];
  assert.deepEqual(ids(cold.dnr), expectedIds, 'cold native DNR');
  const dnrWrites = observation.events.filter(event => event.type === 'dnr');
  if (expired) assert.ok(dnrWrites.length > 0, 'native observer saw Focus protection removed');
  for (const event of [...dnrWrites, { rules: cold.dnr }]) {
    assert.deepEqual(ids(event.rules), expectedIds, 'every applied native DNR ruleset agrees with current Focus');
    for (const rule of event.rules) {
      assert.equal(reason(rule), expired ? 'daily_limit' : 'focus', 'native blocked reason');
      assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
    }
  }
  const expectedSchedule = { ...fixture.schedule,
    handledKeys: expired ? [] : [fixture.current.key] };
  assert.deepEqual(cold.focusSchedule, expectedSchedule, 'durable schedule claim matches the current occurrence');
  const claims = observation.events.filter(event => event.type === 'storage' && event.changes.focusSchedule);
  assert.equal(claims.length, expired ? 0 : 1, 'current occurrence claimed once; expired occurrence never claimed');
  if (!expired) assert.deepEqual(claims[0].changes.focusSchedule.newValue, expectedSchedule);
  assert.equal(cold.statistics?.successfulFocusSessions ?? 0,
    (before.statistics?.successfulFocusSessions ?? 0) + Number(expired), 'completion counted exactly once');
  assert.deepEqual(cold.session, { __bdIdleSession: token }, 'native session survived automatic unload');
  for (const key of ['rules', 'ruleLists', 'activeRuleListId', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions']) {
    assert.deepEqual(cold[key], before[key], `${key} survived idle/wake`);
  }
  assert.deepEqual(cold.dailyRuleUsage.usageSeconds, { '21:general': 840 });
  assert.deepEqual(cold.pendingDailyUsageRemaps, []);
  for (const event of observation.events.filter(event => event.type === 'storage' && event.changes.dailyRuleUsage)) {
    assert.deepEqual(event.changes.dailyRuleUsage.newValue.usageSeconds, { '21:general': 840 },
      'budget is preserved throughout cold recovery');
  }
  const getAlarm = name => observation.nativeAlarms.find(alarm => alarm.name === name);
  assert.equal(getAlarm('start_scheduled_focus')?.scheduledTime, fixture.next.startTime, 'next genuine occurrence is armed');
  if (expired) assert.equal(getAlarm('end_focus_session'), undefined, 'completed one-shot removed');
  else assert.equal(getAlarm('end_focus_session')?.scheduledTime, before.focusSession.focusEndTime,
    'newer session completion rearmed at its own end time');
  assert.ok(getAlarm('update_scheduled_rules')?.scheduledTime > fixture.when, 'native minute alarm advanced');
}
