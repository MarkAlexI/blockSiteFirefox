import test from 'node:test';
import assert from 'node:assert/strict';

import { isRuleActiveNow, getTrackableDailyLimitAssignments } from '../rules/ruleActivation.js';

const tuesdayAt1030 = new Date(2026, 7, 4, 10, 30);

function makeRule(overrides = {}) {
  return {
    id: 1,
    blockURL: 'example.com',
    category: 'social',
    isWhitelist: false,
    assignments: [{
      listId: 'general',
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    }],
    ...overrides
  };
}

function makeScheduledRule({
  days = [1],
  startTime = '22:00',
  endTime = '06:00',
  periods = null,
  listId = 'general',
  legacy = false,
  disabledByUser = false
} = {}) {
  const period = { days, startTime, endTime };
  return makeRule({
    assignments: [{
      listId,
      disabledByUser,
      blockingMode: 'schedule',
      schedule: legacy ? period : { version: 2, periods: periods || [period] },
      dailyLimit: null
    }]
  });
}

test('ordinary General rules are active while General is the active profile', () => {
  assert.equal(isRuleActiveNow(makeRule(), [], false, tuesdayAt1030, 'general'), true);
});

test('rules without an assignment in the active profile stay inactive', () => {
  const rule = makeRule({
    assignments: [{ listId: 'study', blockingMode: 'always', schedule: null, dailyLimit: null }]
  });
  assert.equal(isRuleActiveNow(rule, [], false, tuesdayAt1030, 'general'), false);
  assert.equal(isRuleActiveNow(rule, [], false, tuesdayAt1030, 'study'), true);
});

test('whitelist rules never become DNR blocking rules', () => {
  assert.equal(
    isRuleActiveNow(makeRule({ isWhitelist: true }), [], true, tuesdayAt1030, 'general'),
    false
  );
});

test('Focus Session globally activates blacklist targets before profile and category checks', () => {
  const rule = makeRule({
    category: 'social',
    assignments: [{
      listId: 'work',
      disabledByUser: true,
      blockingMode: 'schedule',
      schedule: null,
      dailyLimit: null
    }]
  });
  assert.equal(isRuleActiveNow(rule, ['social'], true, tuesdayAt1030, 'study'), true);
});

test('disabled assignment and active-profile category state stay inactive outside Focus Session', () => {
  assert.equal(
    isRuleActiveNow(makeRule({
      assignments: [{
        listId: 'general',
        disabledByUser: true,
        blockingMode: 'always',
        schedule: null,
        dailyLimit: null
      }]
    }), [], false, tuesdayAt1030, 'general'),
    false
  );
  assert.equal(
    isRuleActiveNow(makeRule(), ['social'], false, tuesdayAt1030, 'general'),
    false
  );
});

test('the same target can use independent schedules in different profiles', () => {
  const rule = makeRule({
    assignments: [
      {
        listId: 'work',
        blockingMode: 'schedule',
        schedule: { days: [2], startTime: '09:00', endTime: '10:00' },
        dailyLimit: null
      },
      {
        listId: 'study',
        blockingMode: 'schedule',
        schedule: { days: [2], startTime: '10:00', endTime: '11:00' },
        dailyLimit: null
      }
    ]
  });

  assert.equal(isRuleActiveNow(rule, [], false, tuesdayAt1030, 'work'), false);
  assert.equal(isRuleActiveNow(rule, [], false, tuesdayAt1030, 'study'), true);
});

test('version 2 schedules activate when any time group in the active profile matches', () => {
  const scheduled = makeRule({
    assignments: [{
      listId: 'study',
      blockingMode: 'schedule',
      schedule: {
        version: 2,
        periods: [
          { days: [1], startTime: '09:00', endTime: '10:00' },
          { days: [2], startTime: '10:00', endTime: '11:00' }
        ]
      },
      dailyLimit: null
    }]
  });

  assert.equal(isRuleActiveNow(scheduled, [], false, tuesdayAt1030, 'study'), true);
  assert.equal(
    isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 11, 0), 'study'),
    false
  );
});

test('overnight schedules activate inclusively on their selected start weekday', () => {
  const scheduled = makeScheduledRule({ days: [1] });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 3, 21, 59)), false);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 3, 22, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 3, 23, 59)), true);
});

test('overnight schedules continue after midnight using the previous selected weekday', () => {
  const scheduled = makeScheduledRule({ days: [1] });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 0, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 5, 59)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 6, 0)), false);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 22, 0)), false);
});

test('the selected start weekday does not activate its own unrelated early morning', () => {
  const scheduled = makeScheduledRule({ days: [2] });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 1, 0)), false);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 23, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 5, 1, 0)), true);
});

test('Friday overnight schedules continue into Saturday without enabling Saturday night', () => {
  const scheduled = makeScheduledRule({ days: [5] });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 7, 23, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 8, 5, 59)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 8, 22, 0)), false);
});

test('Sunday overnight schedules wrap correctly into Monday', () => {
  const scheduled = makeScheduledRule({ days: [0] });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 9, 23, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 10, 0, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 10, 5, 59)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 10, 6, 0)), false);
});

test('weekday overnight schedules include Saturday morning but not Monday morning', () => {
  const scheduled = makeScheduledRule({ days: [1, 2, 3, 4, 5] });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 8, 4, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 9, 4, 0)), false);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 10, 4, 0)), false);
});

test('weekend overnight schedules continue into Monday but not Saturday morning', () => {
  const scheduled = makeScheduledRule({ days: [0, 6] });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 8, 4, 0)), false);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 9, 4, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 10, 4, 0)), true);
});

test('legacy overnight schedules retain selected-start-day semantics', () => {
  const scheduled = makeScheduledRule({ days: [1], legacy: true });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 3, 23, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 2, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 6, 0)), false);
});

test('mixed same-day and overnight periods independently follow their selected days', () => {
  const scheduled = makeScheduledRule({
    periods: [
      { days: [1], startTime: '22:00', endTime: '06:00' },
      { days: [2], startTime: '09:00', endTime: '17:00' }
    ]
  });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 5, 59)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 8, 59)), false);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 9, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 17, 0)), false);
});

test('overnight schedules retain their start day across a local year boundary', () => {
  const scheduled = makeScheduledRule({ days: [4] });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 11, 31, 23, 59)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2027, 0, 1, 0, 0)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2027, 0, 1, 6, 0)), false);
});

test('an overnight period ending exactly at midnight does not leak into the next day', () => {
  const scheduled = makeScheduledRule({ days: [1], startTime: '22:00', endTime: '00:00' });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 3, 23, 59)), true);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 0, 0)), false);
});

test('zero-duration stored schedules fail closed at every local time', () => {
  const scheduled = makeScheduledRule({ days: [1, 2], startTime: '22:00', endTime: '22:00' });

  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 3, 22, 0)), false);
  assert.equal(isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 1, 0)), false);
});

test('disabled schedules, categories, and inactive profiles stay inactive overnight', () => {
  const overnight = new Date(2026, 7, 4, 1, 0);

  assert.equal(isRuleActiveNow(makeScheduledRule({ disabledByUser: true }), [], false, overnight), false);
  assert.equal(isRuleActiveNow(makeScheduledRule(), ['social'], false, overnight), false);
  assert.equal(isRuleActiveNow(makeScheduledRule({ listId: 'study' }), [], false, overnight, 'general'), false);
  assert.equal(isRuleActiveNow(makeScheduledRule({ listId: 'study' }), [], false, overnight, 'study'), true);
});

test('malformed stored schedule periods fail closed without breaking activation', () => {
  const scheduled = makeRule({
    assignments: [{
      listId: 'general',
      blockingMode: 'schedule',
      schedule: { version: 2, periods: [{ days: null, startTime: 'bad', endTime: null }] },
      dailyLimit: null
    }]
  });
  assert.equal(isRuleActiveNow(scheduled, [], false, tuesdayAt1030, 'general'), false);
});

test('Daily Limit is evaluated only for the active profile assignment', () => {
  const limited = makeRule({
    assignments: [
      { listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null },
      { listId: 'study', blockingMode: 'daily_limit', dailyLimit: { minutes: 30 }, schedule: null }
    ]
  });

  assert.equal(isRuleActiveNow(limited, [], false, tuesdayAt1030, 'study', { '1:study': 1799 }), false);
  assert.equal(isRuleActiveNow(limited, [], false, tuesdayAt1030, 'study', { '1:study': 1800 }), true);
  assert.equal(isRuleActiveNow(limited, [], false, tuesdayAt1030, 'general', { '1:study': 0 }), true);
});

test('Daily Limit tracker receives only the active profile assignment', () => {
  const rule = makeRule({
    assignments: [
      { listId: 'work', blockingMode: 'daily_limit', dailyLimit: { minutes: 10 }, schedule: null },
      { listId: 'study', blockingMode: 'daily_limit', dailyLimit: { minutes: 20 }, schedule: null }
    ]
  });
  assert.deepEqual(
    getTrackableDailyLimitAssignments(rule, 'study', tuesdayAt1030, {}),
    [{
      listId: 'study',
      disabledByUser: false,
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 20 },
      schedule: null
    }]
  );
});

test('disabling General does not disable the same target after Study Daily Limit is reached', () => {
  const rule = makeRule({
    blockURL: 'yout',
    assignments: [
      {
        listId: 'general',
        disabledByUser: true,
        blockingMode: 'always',
        schedule: null,
        dailyLimit: null
      },
      {
        listId: 'study',
        disabledByUser: false,
        blockingMode: 'daily_limit',
        dailyLimit: { minutes: 1 },
        schedule: null
      }
    ]
  });

  assert.equal(isRuleActiveNow(rule, [], false, tuesdayAt1030, 'general', {}), false);
  assert.equal(
    isRuleActiveNow(rule, [], false, tuesdayAt1030, 'study', { '1:study': 60 }),
    true
  );
});

test('Focus Session blocks a Daily Limit target even before the active profile budget is exhausted', () => {
  const limited = makeRule({
    assignments: [{ listId: 'study', blockingMode: 'daily_limit', dailyLimit: { minutes: 30 }, schedule: null }]
  });
  assert.equal(isRuleActiveNow(limited, [], true, tuesdayAt1030, 'general', {}), true);
});
