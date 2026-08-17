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
