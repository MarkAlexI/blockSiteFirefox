import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DailyLimitManager,
  getLocalDateKey,
  normalizeDailyRuleUsageState,
  PENDING_DAILY_USAGE_REMAPS_KEY
} from '../rules/dailyLimitManager.js';

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    setCalls: 0,
    async get(key) {
      if (typeof key === 'string') return { [key]: data[key] };
      return { ...data };
    },
    async set(values) {
      this.setCalls++;
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

test('idle samples do not create Daily Limit storage or rewrite an inactive baseline', async () => {
  const now = new Date(2026, 7, 22, 12, 0, 0);
  const emptyStorage = createStorage();
  const emptyManager = new DailyLimitManager(emptyStorage);

  const first = await emptyManager.recordSample([], now);
  assert.equal(emptyStorage.setCalls, 0);
  assert.equal(emptyStorage.data.dailyRuleUsage, undefined);
  assert.equal(first.addedSeconds, 0);

  const storedBaseline = now.getTime() - 60_000;
  const initializedStorage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: { '7:general': 90 },
      lastSample: { timestamp: storedBaseline, assignmentKeys: [] }
    }
  });
  const initializedManager = new DailyLimitManager(initializedStorage);

  await initializedManager.recordSample([], now);
  await initializedManager.recordSample([], new Date(now.getTime() + 60_000));

  assert.equal(initializedStorage.setCalls, 0);
  assert.equal(initializedStorage.data.dailyRuleUsage.lastSample.timestamp, storedBaseline);
  assert.equal(initializedStorage.data.dailyRuleUsage.usageSeconds['7:general'], 90);
});

test('an idle sample still clears stale Daily Limit usage after the local date changes', async () => {
  const now = new Date(2026, 7, 22, 0, 1, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-21',
      usageSeconds: { '7:general': 90 },
      lastSample: { timestamp: now.getTime() - 120_000, assignmentKeys: ['7:general'] }
    }
  });
  const manager = new DailyLimitManager(storage);

  await manager.recordSample([], now);

  assert.equal(storage.setCalls, 1);
  assert.equal(storage.data.dailyRuleUsage.date, '2026-08-22');
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, {});
  assert.equal(storage.data.dailyRuleUsage.lastSample, null);
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

test('pruning unchanged or absent assignment usage does not write storage', async () => {
  const now = new Date(2026, 7, 22, 12, 0, 0);
  const emptyStorage = createStorage();
  await new DailyLimitManager(emptyStorage).pruneAssignmentKeys([], now);
  assert.equal(emptyStorage.setCalls, 0);

  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: { '7:general': 90 },
      lastSample: { timestamp: now.getTime(), assignmentKeys: ['7:general'] }
    }
  });
  await new DailyLimitManager(storage).pruneAssignmentKeys(['7:general'], now);
  assert.equal(storage.setCalls, 0);
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

test('remapping a rule without tracked Daily Limit usage does not write storage', async () => {
  const now = new Date(2026, 7, 22, 12, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: { '9:general': 60 },
      lastSample: { timestamp: now.getTime(), assignmentKeys: [] }
    }
  });

  await new DailyLimitManager(storage).remapAssignmentKey(7, 'study', 7, 'general', now);

  assert.equal(storage.setCalls, 0);
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, { '9:general': 60 });
});

test('batch remapping preserves usage and active assignments with one storage write', async () => {
  const now = new Date(2026, 7, 22, 12, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: {
        '1:study': 40,
        '1:general': 90,
        '2:study': 120,
        '3:other': 30
      },
      lastSample: {
        timestamp: now.getTime(),
        assignmentKeys: ['1:study', '1:general', '2:study']
      }
    }
  });
  const state = await new DailyLimitManager(storage).remapAssignmentKeys([
    { oldRuleId: 1, oldListId: 'study', newRuleId: 1, newListId: 'general' },
    { oldRuleId: 2, oldListId: 'study', newRuleId: 2, newListId: 'general' }
  ], now);

  assert.equal(storage.setCalls, 1);
  assert.deepEqual(state.usageSeconds, {
    '1:general': 90,
    '3:other': 30,
    '2:general': 120
  });
  assert.deepEqual(state.lastSample.assignmentKeys, ['1:general', '2:general']);
});

test('Daily Limit journal commits updated rules and pending remaps in one atomic write', async () => {
  const now = new Date(2026, 7, 22, 12, 0, 0);
  const storage = createStorage({
    rules: [{ id: 21, listId: 'study' }],
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: { '21:study': 840 },
      lastSample: { timestamp: now.getTime(), assignmentKeys: ['21:study'] }
    }
  });
  const manager = new DailyLimitManager(storage);
  const nextRules = [{ id: 21, listId: 'general' }];
  const remap = {
    oldRuleId: 21, oldListId: 'study', newRuleId: 21, newListId: 'general'
  };

  await manager.stagePendingRemaps({ rules: nextRules }, [remap]);

  assert.equal(storage.setCalls, 1);
  assert.deepEqual(storage.data.rules, nextRules);
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], [remap]);
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, { '21:study': 840 });
  assert.deepEqual(await manager.getUsageSeconds(now), { '21:general': 840 });
  assert.equal(storage.setCalls, 1);
});

test('journal recovery transfers usage and clears its marker in the same storage write', async () => {
  const now = new Date(2026, 7, 22, 12, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: { '21:study': 840, '21:general': 120 },
      lastSample: { timestamp: now.getTime(), assignmentKeys: ['21:study'] }
    },
    [PENDING_DAILY_USAGE_REMAPS_KEY]: [{
      oldRuleId: 21, oldListId: 'study', newRuleId: 21, newListId: 'general'
    }]
  });

  const recovered = await new DailyLimitManager(storage).recoverPendingRemaps(now);

  assert.equal(recovered.recovered, true);
  assert.equal(storage.setCalls, 1);
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, { '21:general': 840 });
  assert.deepEqual(storage.data.dailyRuleUsage.lastSample.assignmentKeys, ['21:general']);
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
});

test('Daily Limit edits without elapsed time or an active sample skip unnecessary journal writes', async () => {
  const storage = createStorage({
    rules: [{ id: 21, listId: 'study' }],
    dailyRuleUsage: {
      version: 2,
      date: getLocalDateKey(),
      usageSeconds: { '9:general': 120 },
      lastSample: null
    }
  });
  const manager = new DailyLimitManager(storage);

  const pending = await manager.stagePendingRemaps({
    rules: [{ id: 21, listId: 'general' }]
  }, [{
    oldRuleId: 21, oldListId: 'study', newRuleId: 21, newListId: 'general'
  }]);
  await manager.recoverPendingRemaps();

  assert.deepEqual(pending, []);
  assert.equal(storage.setCalls, 1);
  assert.equal(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], undefined);
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, { '9:general': 120 });
});

test('an active zero-second Daily Limit segment is still protected by the durable journal', async () => {
  const now = new Date();
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: getLocalDateKey(now),
      usageSeconds: {},
      lastSample: { timestamp: now.getTime(), assignmentKeys: ['21:study'] }
    }
  });
  const manager = new DailyLimitManager(storage);

  await manager.stagePendingRemaps({ rules: [{ id: 21 }] }, [{
    oldRuleId: 21, oldListId: 'study', newRuleId: 21, newListId: 'general'
  }]);

  assert.equal(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY].length, 1);
  await manager.recoverPendingRemaps(now);
  assert.deepEqual(storage.data.dailyRuleUsage.lastSample.assignmentKeys, ['21:general']);
  assert.equal(storage.setCalls, 2);
});

test('failed atomic journal staging cannot update rules without preserving their old usage', async () => {
  const initialRules = [{ id: 21, listId: 'study' }];
  const storage = createStorage({ rules: initialRules });
  storage.set = async () => { throw new Error('local storage quota exceeded'); };
  const manager = new DailyLimitManager(storage);

  await assert.rejects(
    manager.stagePendingRemaps({ rules: [{ id: 21, listId: 'general' }] }, [{
      oldRuleId: 21, oldListId: 'study', newRuleId: 21, newListId: 'general'
    }]),
    /quota exceeded/
  );

  assert.deepEqual(storage.data.rules, initialRules);
  assert.equal(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], undefined);
});

test('failed recovery writes preserve old usage, protection, and the retry journal', async () => {
  const now = new Date(2026, 7, 22, 12, 0, 0);
  const remap = {
    oldRuleId: 21, oldListId: 'study', newRuleId: 21, newListId: 'general'
  };
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: { '21:study': 840 },
      lastSample: null
    },
    [PENDING_DAILY_USAGE_REMAPS_KEY]: [remap]
  });
  const manager = new DailyLimitManager(storage);
  const originalSet = storage.set.bind(storage);
  storage.set = async () => { throw new Error('temporary usage write failure'); };

  await assert.rejects(manager.recoverPendingRemaps(now), /write failure/);
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, { '21:study': 840 });
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], [remap]);
  assert.deepEqual(await manager.getUsageSeconds(now), { '21:general': 840 });

  storage.set = originalSet;
  await manager.pruneAssignmentKeys(['21:general'], now);
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, { '21:study': 840 });
  await manager.recoverPendingRemaps(now);
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, { '21:general': 840 });
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
  assert.equal(storage.setCalls, 1);
});

test('journal recovery never restores stale usage after the local date changes', async () => {
  const now = new Date(2026, 7, 23, 0, 1, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: { '21:study': 840 },
      lastSample: { timestamp: now.getTime() - 120_000, assignmentKeys: ['21:study'] }
    },
    [PENDING_DAILY_USAGE_REMAPS_KEY]: [{
      oldRuleId: 21, oldListId: 'study', newRuleId: 21, newListId: 'general'
    }]
  });

  await new DailyLimitManager(storage).recoverPendingRemaps(now);

  assert.equal(storage.setCalls, 1);
  assert.equal(storage.data.dailyRuleUsage.date, '2026-08-23');
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, {});
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
});

test('recovery without a pending journal never writes idle storage', async () => {
  for (const initial of [{}, { [PENDING_DAILY_USAGE_REMAPS_KEY]: [] }]) {
    const storage = createStorage(initial);
    const result = await new DailyLimitManager(storage).recoverPendingRemaps();
    assert.equal(result.recovered, false);
    assert.equal(storage.setCalls, 0);
  }
});

test('batched journal recovery keeps maximum usage and migrates multiple profiles together', async () => {
  const now = new Date(2026, 7, 22, 12, 0, 0);
  const storage = createStorage({
    dailyRuleUsage: {
      version: 2,
      date: '2026-08-22',
      usageSeconds: { '1:study': 40, '1:general': 90, '2:study': 120 },
      lastSample: { timestamp: now.getTime(), assignmentKeys: ['1:study', '2:study'] }
    },
    [PENDING_DAILY_USAGE_REMAPS_KEY]: [
      { oldRuleId: 1, oldListId: 'study', newRuleId: 1, newListId: 'general' },
      { oldRuleId: 2, oldListId: 'study', newRuleId: 2, newListId: 'general' }
    ]
  });

  await new DailyLimitManager(storage).recoverPendingRemaps(now);

  assert.equal(storage.setCalls, 1);
  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, {
    '1:general': 90,
    '2:general': 120
  });
  assert.deepEqual(storage.data.dailyRuleUsage.lastSample.assignmentKeys,
    ['1:general', '2:general']);
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

test('an active segment is persisted when closed and subsequent idle samples do not rewrite it', async () => {
  const storage = createStorage();
  const manager = new DailyLimitManager(storage);
  const start = new Date(2026, 7, 22, 12, 0, 0);

  await manager.recordSample(['7:general'], start);
  await manager.resetSample(new Date(start.getTime() + 30_000));
  assert.equal(storage.setCalls, 2);

  await manager.recordSample([], new Date(start.getTime() + 90_000));
  await manager.resetSample(new Date(start.getTime() + 120_000));

  assert.equal(storage.setCalls, 2);
  assert.equal(storage.data.dailyRuleUsage.usageSeconds['7:general'], 30);
  assert.deepEqual(storage.data.dailyRuleUsage.lastSample.assignmentKeys, []);
});
