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
    version: 2,
    date: '2026-08-14',
    usageSeconds: { '1:general': 999 },
    lastSample: { timestamp: now.getTime() - 1000, assignmentKeys: ['1:general'] }
  }, now);
  assert.deepEqual(state.usageSeconds, {});
  assert.equal(state.lastSample, null);
});

test('usage is attributed only to assignment keys present at both samples', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 15, 12, 0, 0);
  await manager.recordSample(['7:work', '7:study'], start);
  const result = await manager.recordSample(['7:study', '9:general'], new Date(start.getTime() + 60_000));
  assert.deepEqual(result.accountedAssignmentKeys, ['7:study']);
  assert.equal(result.addedSeconds, 60);
  assert.deepEqual(result.usageUpdates['7:study'], {
    previousUsageSeconds: 0,
    currentUsageSeconds: 60
  });
  assert.deepEqual(result.state.lastSample.assignmentKeys, ['7:study', '9:general']);
});

test('large gaps are never charged because foreground continuity is unknown', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 15, 12, 0, 0);
  await manager.recordSample(['7:study'], start);
  const result = await manager.recordSample(['7:study'], new Date(start.getTime() + 10 * 60_000));
  assert.deepEqual(result.accountedAssignmentKeys, []);
  assert.equal(result.addedSeconds, 0);
  assert.deepEqual(result.state.usageSeconds, {});
});

test('large gaps are not charged when active assignments changed', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 15, 12, 0, 0);
  await manager.recordSample(['7:work'], start);
  const result = await manager.recordSample(['9:general'], new Date(start.getTime() + 10 * 60_000));
  assert.equal(result.addedSeconds, 0);
  assert.deepEqual(result.state.usageSeconds, {});
  assert.deepEqual(result.state.lastSample.assignmentKeys, ['9:general']);
});

test('usage state prunes deleted assignment keys', async () => {
  const now = new Date(2026, 7, 15, 12, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-15',
      usageSeconds: { '1:general': 60, '2:study': 120 },
      lastSample: { timestamp: now.getTime(), assignmentKeys: ['2:study'] }
    }
  });
  const manager = new DailyLimitManager(storage);
  const state = await manager.pruneAssignmentKeys(['1:general'], now);
  assert.deepEqual(state.usageSeconds, { '1:general': 60 });
  assert.deepEqual(state.lastSample.assignmentKeys, []);
});

test('assignment usage can be remapped when editing splits a shared target', async () => {
  const now = new Date(2026, 7, 17, 10, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-17',
      usageSeconds: { '1:list-2': 42 },
      lastSample: { timestamp: now.getTime(), assignmentKeys: ['1:list-2'] }
    }
  });
  const manager = new DailyLimitManager(storage);
  const state = await manager.remapAssignmentKey(1, 'list-2', 9, 'list-2', now);
  assert.deepEqual(state.usageSeconds, { '9:list-2': 42 });
  assert.deepEqual(state.lastSample.assignmentKeys, ['9:list-2']);
});
