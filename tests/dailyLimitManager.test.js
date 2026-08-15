import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DailyLimitManager,
  getLocalDateKey,
  normalizeDailyRuleUsageState
} from '../rules/dailyLimitManager.js';

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      if (typeof key === 'string') return { [key]: data[key] };
      return { ...data };
    },
    async set(values) {
      Object.assign(data, values);
    }
  };
}

test('daily usage is scoped to the local calendar date', () => {
  const now = new Date(2026, 7, 15, 12, 0, 0);
  assert.equal(getLocalDateKey(now), '2026-08-15');
  const state = normalizeDailyRuleUsageState({
    date: '2026-08-14',
    usageSeconds: { 1: 999 },
    lastSample: { timestamp: now.getTime() - 1000, ruleId: 1 }
  }, now);
  assert.deepEqual(state.usageSeconds, {});
  assert.equal(state.lastSample, null);
});

test('usage is attributed to the previous sampled rule', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 15, 12, 0, 0);
  await manager.recordSample(7, start);
  const result = await manager.recordSample(9, new Date(start.getTime() + 60_000));
  assert.equal(result.accountedRuleId, 7);
  assert.equal(result.addedSeconds, 60);
  assert.equal(result.currentUsageSeconds, 60);
  assert.equal(result.state.lastSample.ruleId, 9);
});

test('large same-rule gaps recover only one conservative minute', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 15, 12, 0, 0);
  await manager.recordSample(7, start);
  const result = await manager.recordSample(7, new Date(start.getTime() + 10 * 60_000));
  assert.equal(result.accountedRuleId, 7);
  assert.equal(result.addedSeconds, 60);
  assert.deepEqual(result.state.usageSeconds, { 7: 60 });
});

test('large gaps are not charged when the active rule changed', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 15, 12, 0, 0);
  await manager.recordSample(7, start);
  const result = await manager.recordSample(9, new Date(start.getTime() + 10 * 60_000));
  assert.equal(result.addedSeconds, 0);
  assert.deepEqual(result.state.usageSeconds, {});
  assert.equal(result.state.lastSample.ruleId, 9);
});

test('usage state prunes deleted rule ids', async () => {
  const now = new Date(2026, 7, 15, 12, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 1,
      date: '2026-08-15',
      usageSeconds: { 1: 60, 2: 120 },
      lastSample: { timestamp: now.getTime(), ruleId: 2 }
    }
  });
  const manager = new DailyLimitManager(storage);
  const state = await manager.pruneRuleIds([1], now);
  assert.deepEqual(state.usageSeconds, { 1: 60 });
  assert.equal(state.lastSample.ruleId, null);
});
