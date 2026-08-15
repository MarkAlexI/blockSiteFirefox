import test from 'node:test';
import assert from 'node:assert/strict';

import { isRuleActiveNow } from '../rules/ruleActivation.js';

const tuesdayAt1030 = new Date(2026, 7, 4, 10, 30);

function makeRule(overrides = {}) {
  return {
    id: 1,
    blockURL: 'example.com',
    category: 'social',
    disabledByUser: false,
    isWhitelist: false,
    schedule: null,
    ...overrides
  };
}

test('ordinary unscheduled rules are active', () => {
  assert.equal(isRuleActiveNow(makeRule(), [], false, tuesdayAt1030), true);
});

test('whitelist rules never become DNR blocking rules', () => {
  assert.equal(
    isRuleActiveNow(makeRule({ isWhitelist: true }), [], true, tuesdayAt1030),
    false
  );
});

test('focus session activates blacklist rules before disabled checks', () => {
  const rule = makeRule({
    disabledByUser: true,
    category: 'muted'
  });

  assert.equal(isRuleActiveNow(rule, ['muted'], true, tuesdayAt1030), true);
});

test('disabled rules and disabled categories stay inactive outside focus mode', () => {
  assert.equal(
    isRuleActiveNow(makeRule({ disabledByUser: true }), [], false, tuesdayAt1030),
    false
  );
  assert.equal(
    isRuleActiveNow(makeRule(), ['social'], false, tuesdayAt1030),
    false
  );
});

test('scheduled rules are active only on selected days and inside the interval', () => {
  const scheduled = makeRule({
    schedule: {
      days: [2],
      startTime: '10:00',
      endTime: '11:00'
    }
  });

  assert.equal(isRuleActiveNow(scheduled, [], false, tuesdayAt1030), true);
  assert.equal(
    isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 11, 0)),
    false
  );
  assert.equal(
    isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 5, 10, 30)),
    false
  );
});


test('version 2 schedules activate when any time group matches', () => {
  const scheduled = makeRule({
    schedule: {
      version: 2,
      periods: [
        { days: [1], startTime: '09:00', endTime: '10:00' },
        { days: [2], startTime: '10:00', endTime: '11:00' }
      ]
    }
  });

  assert.equal(isRuleActiveNow(scheduled, [], false, tuesdayAt1030), true);
  assert.equal(
    isRuleActiveNow(scheduled, [], false, new Date(2026, 7, 4, 11, 0)),
    false
  );
});

test('malformed stored schedule periods fail closed without breaking activation', () => {
  const scheduled = makeRule({
    schedule: {
      version: 2,
      periods: [{ days: null, startTime: 'bad', endTime: null }]
    }
  });

  assert.equal(isRuleActiveNow(scheduled, [], false, tuesdayAt1030), false);
});

test('a rule in a disabled rule list stays inactive outside Focus Session', () => {
  const rule = {
    blockURL: 'work.example',
    category: 'work',
    listId: 'list-1',
    disabledByUser: false,
    isWhitelist: false,
    schedule: null
  };

  assert.equal(
    isRuleActiveNow(rule, [], false, new Date(2026, 7, 15, 12, 0), ['list-1']),
    false
  );
  assert.equal(
    isRuleActiveNow(rule, [], true, new Date(2026, 7, 15, 12, 0), ['list-1']),
    true
  );
});
