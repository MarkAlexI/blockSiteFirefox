import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_SCHEDULE,
  BLOCKING_MODE_DAILY_LIMIT,
  getRuleBlockingMode,
  normalizeBlockingConfig,
  normalizeDailyLimit,
  validateBlockingConfig,
  isDailyLimitReached
} from '../rules/blockingMode.js';

test('legacy rules infer always or schedule mode', () => {
  assert.equal(getRuleBlockingMode({ schedule: null }), BLOCKING_MODE_ALWAYS);
  assert.equal(getRuleBlockingMode({ schedule: { days: [1] } }), BLOCKING_MODE_SCHEDULE);
});

test('daily limit accepts whole minute budgets from 1 to 1440', () => {
  assert.deepEqual(normalizeDailyLimit({ minutes: 30 }), { minutes: 30 });
  assert.deepEqual(normalizeDailyLimit({ minutes: '45' }), { minutes: 45 });
  assert.equal(normalizeDailyLimit({ minutes: 0 }), null);
  assert.equal(normalizeDailyLimit({ minutes: 1441 }), null);
});

test('blocking configuration keeps schedule and daily limit mutually exclusive', () => {
  assert.deepEqual(
    validateBlockingConfig({ blockingMode: BLOCKING_MODE_ALWAYS, schedule: null, dailyLimit: null }),
    { isValid: true, errors: [] }
  );
  assert.deepEqual(
    validateBlockingConfig({ blockingMode: BLOCKING_MODE_SCHEDULE, schedule: null, dailyLimit: null }).errors,
    ['schedule_required']
  );
  assert.deepEqual(
    validateBlockingConfig({ blockingMode: BLOCKING_MODE_DAILY_LIMIT, schedule: {}, dailyLimit: { minutes: 30 } }).errors,
    ['blocking_mode_conflict']
  );
});

test('normalization removes configuration that does not belong to the selected mode', () => {
  assert.deepEqual(normalizeBlockingConfig({
    blockingMode: BLOCKING_MODE_DAILY_LIMIT,
    schedule: { days: [1] },
    dailyLimit: { minutes: 25 }
  }), {
    blockingMode: BLOCKING_MODE_DAILY_LIMIT,
    schedule: null,
    dailyLimit: { minutes: 25 }
  });
});

test('daily limit reached uses accumulated seconds', () => {
  const rule = { blockingMode: BLOCKING_MODE_DAILY_LIMIT, dailyLimit: { minutes: 10 } };
  assert.equal(isDailyLimitReached(rule, 599), false);
  assert.equal(isDailyLimitReached(rule, 600), true);
});
