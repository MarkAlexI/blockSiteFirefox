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

test('normalizing a stale usage snapshot cannot overwrite a concurrently recorded sample', async () => {
  const start = new Date(2026, 7, 21, 12, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 1,
      date: '2026-08-21',
      usageSeconds: { '7:general': 40 },
      lastSample: { timestamp: start.getTime(), assignmentKeys: ['7:general'] },
      outdatedField: true
    }
  });
  const manager = new DailyLimitManager(storage);
  const originalSet = storage.set.bind(storage);
  let releaseNormalization;
  let normalizationStarted;
  const normalizationGate = new Promise(resolve => { releaseNormalization = resolve; });
  const normalizationReady = new Promise(resolve => { normalizationStarted = resolve; });
  let delayed = false;
  storage.set = async values => {
    if (!delayed) {
      delayed = true;
      normalizationStarted();
      await normalizationGate;
    }
    return originalSet(values);
  };

  const read = manager.readState(start);
  await normalizationReady;
  const sample = manager.recordSample(['7:general'], new Date(start.getTime() + 20_000));
  await new Promise(resolve => setImmediate(resolve));
  releaseNormalization();
  await Promise.all([read, sample]);

  assert.equal(storage.data.dailyRuleUsage.usageSeconds['7:general'], 60);
  assert.equal(storage.data.dailyRuleUsage.lastSample.timestamp, start.getTime() + 20_000);
});

test('a usage read requested after a pending sample sees that sample', async () => {
  const start = new Date(2026, 7, 21, 12, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-21',
      usageSeconds: { '7:general': 40 },
      lastSample: { timestamp: start.getTime(), assignmentKeys: ['7:general'] }
    }
  });
  const manager = new DailyLimitManager(storage);
  const originalSet = storage.set.bind(storage);
  let releaseSample;
  let sampleWriteStarted;
  const sampleGate = new Promise(resolve => { releaseSample = resolve; });
  const sampleReady = new Promise(resolve => { sampleWriteStarted = resolve; });
  let delayed = false;
  storage.set = async values => {
    if (!delayed) {
      delayed = true;
      sampleWriteStarted();
      await sampleGate;
    }
    return originalSet(values);
  };

  const later = new Date(start.getTime() + 20_000);
  const sample = manager.recordSample(['7:general'], later);
  await sampleReady;
  const read = manager.readState(later);
  await new Promise(resolve => setImmediate(resolve));
  releaseSample();
  const [, state] = await Promise.all([sample, read]);

  assert.equal(state.usageSeconds['7:general'], 60);
  assert.equal(state.lastSample.timestamp, later.getTime());
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


test('segment boundary charges the previous assignment even when the active assignment changes', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 19, 12, 0, 0);
  await manager.recordSample(['7:general'], start);
  const result = await manager.recordSample(
    ['9:general'],
    new Date(start.getTime() + 20_000),
    { closePreviousSegment: true }
  );

  assert.equal(result.addedSeconds, 20);
  assert.deepEqual(result.accountedAssignmentKeys, ['7:general']);
  assert.equal(result.state.usageSeconds['7:general'], 20);
  assert.equal(result.state.usageSeconds['9:general'], undefined);
  assert.deepEqual(result.state.lastSample.assignmentKeys, ['9:general']);
});

test('resetSample closes the active segment before clearing the baseline', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 19, 12, 0, 0);
  await manager.recordSample(['7:general'], start);
  const result = await manager.resetSample(new Date(start.getTime() + 15_000));

  assert.equal(result.addedSeconds, 15);
  assert.equal(result.state.usageSeconds['7:general'], 15);
  assert.deepEqual(result.state.lastSample.assignmentKeys, []);
});
