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


for (const raw of [
  { date: '2026-10-06', lastSample: null, usageSeconds: { '21:general': 840 }, version: 2 },
  { version: 1, date: '2026-10-06', usageSeconds: { '21:general': '840.9', invalid: 10 } },
  { version: 2, date: '2026-10-05', usageSeconds: { '21:general': 840 }, lastSample: null },
  undefined
]) {
  test(`usage getters normalize in memory without writing storage: ${JSON.stringify(raw)}`, async () => {
    const now = new Date(2026, 9, 6, 12);
    const storage = createStorage({ dailyRuleUsage: structuredClone(raw) });
    const manager = new DailyLimitManager(storage);
    const expected = normalizeDailyRuleUsageState(raw, now).usageSeconds;

    const usage = await manager.getUsageSeconds(now);
    assert.deepEqual(usage, expected);
    usage['21:general'] = 9999;
    assert.equal(storage.setCalls, 0);
    assert.deepEqual(storage.data.dailyRuleUsage, raw);
  });
}

test('a delayed Options usage read cannot restore counters deleted by the worker', async () => {
  const now = new Date(2026, 9, 6, 12);
  // Chrome storage reorders object properties, so stringify-based comparison
  // treats this otherwise normalized snapshot as needing a write.
  const storage = createStorage({ dailyRuleUsage: {
    date: getLocalDateKey(now), lastSample: null, usageSeconds: { '21:general': 840 }, version: 2
  } });
  let releaseRead, readStarted;
  const held = new Promise(resolve => { releaseRead = resolve; });
  const captured = new Promise(resolve => { readStarted = resolve; });
  let firstRead = true;
  storage.get = async key => {
    const snapshot = { [key]: structuredClone(storage.data[key]) };
    if (firstRead) { firstRead = false; readStarted(); await held; }
    return snapshot;
  };
  // Separate instances represent independent extension contexts and queues.
  const options = new DailyLimitManager(storage);
  const worker = new DailyLimitManager(storage);
  const pendingRead = options.getUsageSeconds(now);
  await captured;
  try {
    await worker.pruneAssignmentKeys([], now);
    assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, {});
  } finally { releaseRead(); }
  await pendingRead;

  assert.deepEqual(storage.data.dailyRuleUsage.usageSeconds, {});
  assert.equal(storage.setCalls, 1, 'only the worker writes the pruned state');
});

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
  const now = new Date();
  const storage = createStorage({
    rules: [{ id: 21, listId: 'study' }],
    dailyRuleUsage: {
      version: 2,
      date: getLocalDateKey(now),
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


test('usage continuity a fresh manager consumes a stored remap before accounting its first sample', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const remap = { oldRuleId: 1, oldListId: 'study', newRuleId: 2, newListId: 'study' };
  const storage = createStorage({ dailyRuleUsage: { version: 2, date: getLocalDateKey(now), usageSeconds: { '1:study': 100, '1:general': 70 },
    lastSample: { timestamp: now.getTime() - 20_000, assignmentKeys: ['1:study'] } }, [PENDING_DAILY_USAGE_REMAPS_KEY]: [remap] });
  const writes = []; const set = storage.set.bind(storage);
  storage.set = async values => { writes.push(structuredClone(values)); return set(values); };
  const result = await new DailyLimitManager(storage).recordSample(['2:study'], now);
  assert.deepEqual(result.state.usageSeconds, { '2:study': 120, '1:general': 70 });
  assert.deepEqual(result.state.lastSample.assignmentKeys, ['2:study']);
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
  assert.equal(writes.length, 1);
  assert.equal(Object.hasOwn(writes[0], 'dailyRuleUsage'), true);
  assert.equal(Object.hasOwn(writes[0], PENDING_DAILY_USAGE_REMAPS_KEY), true);
});

function continuityStorage(now, { lastSample = true, date = getLocalDateKey(now) } = {}) {
  return createStorage({ dailyRuleUsage: { version: 2, date, usageSeconds: { '1:study': 100, '1:general': 70 },
    lastSample: lastSample ? { timestamp: now.getTime() - 20_000, assignmentKeys: ['1:study'] } : null },
    [PENDING_DAILY_USAGE_REMAPS_KEY]: [{ oldRuleId: 1, oldListId: 'study', newRuleId: 2, newListId: 'study' }] });
}

test('usage continuity failed sample commit preserves the journal and retries without double accounting', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const storage = continuityStorage(now); const original = structuredClone(storage.data);
  const manager = new DailyLimitManager(storage); const set = storage.set.bind(storage);
  storage.set = async () => { throw new Error('sample write unavailable'); };
  await assert.rejects(manager.recordSample(['2:study'], now), /write unavailable/);
  assert.deepEqual(storage.data, original);
  assert.deepEqual(await manager.getUsageSeconds(now), { '2:study': 100, '1:general': 70 });
  storage.set = set;
  assert.equal((await manager.recordSample(['2:study'], now)).state.usageSeconds['2:study'], 120);
  assert.equal((await manager.recordSample(['2:study'], now)).state.usageSeconds['2:study'], 120);
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
  assert.equal((await manager.recoverPendingRemaps(now)).recovered, false);
});

test('usage continuity journal read failure does not write a sample or erase source usage', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const storage = continuityStorage(now); const before = structuredClone(storage.data);
  const get = storage.get.bind(storage);
  storage.get = async keys => {
    if (Array.isArray(keys) && keys.includes(PENDING_DAILY_USAGE_REMAPS_KEY)) throw new Error('journal read unavailable');
    return get(keys);
  };
  const manager = new DailyLimitManager(storage);
  await assert.rejects(manager.recordSample(['2:study'], now), /read unavailable/);
  assert.deepEqual(storage.data, before); assert.equal(storage.setCalls, 0);
  storage.get = get;
  assert.equal((await manager.recordSample(['2:study'], now)).state.usageSeconds['2:study'], 120);
});

test('usage continuity superseded sample preserves its stored remap and queued samples remain usable', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const storage = continuityStorage(now); const before = structuredClone(storage.data);
  let current = true; const get = storage.get.bind(storage);
  storage.get = async keys => { const snapshot = await get(keys); current = false; return snapshot; };
  const manager = new DailyLimitManager(storage);
  assert.deepEqual(await manager.recordSample(['2:study'], now, { shouldContinue: () => current }), { superseded: true });
  assert.deepEqual(storage.data, before); assert.equal(storage.setCalls, 0);
  storage.get = get;
  assert.equal((await manager.recordSample(['2:study'], now)).state.usageSeconds['2:study'], 120);
});

test('usage continuity empty sample still commits its stored remap atomically', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const storage = continuityStorage(now, { lastSample: false });
  const result = await new DailyLimitManager(storage).recordSample([], now);
  assert.deepEqual(result.state.usageSeconds, { '2:study': 100, '1:general': 70 });
  assert.equal(result.state.lastSample, null);
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
  assert.equal(storage.setCalls, 1);
});

test('usage continuity pause closes the remapped segment once before clearing its sample', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const storage = continuityStorage(now); const manager = new DailyLimitManager(storage);
  const result = await manager.resetSample(now);
  assert.deepEqual(result.state.usageSeconds, { '2:study': 120, '1:general': 70 });
  assert.deepEqual(result.state.lastSample.assignmentKeys, []);
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
  assert.equal((await manager.resetSample(now)).state.usageSeconds['2:study'], 120);
});

test('usage continuity chained move remaps preserve elapsed time through recovery and restart', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const storage = continuityStorage(now);
  storage.data[PENDING_DAILY_USAGE_REMAPS_KEY].push({ oldRuleId: 2, oldListId: 'study', newRuleId: 3, newListId: 'general' });
  const manager = new DailyLimitManager(storage);
  assert.deepEqual((await manager.recordSample(['3:general'], now)).state.usageSeconds, { '3:general': 120, '1:general': 70 });
  const restarted = new DailyLimitManager(storage);
  assert.equal((await restarted.recoverPendingRemaps(now)).recovered, false);
  assert.equal((await restarted.recordSample(['3:general'], new Date(now.getTime() + 5_000))).state.usageSeconds['3:general'], 125);
});

test('usage continuity legacy numeric usage keeps its source baseline and the moved active segment', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const storage = continuityStorage(now);
  storage.data.dailyRuleUsage = { version: 1, date: getLocalDateKey(now), usageSeconds: { '1': 100 }, lastSample: { timestamp: now.getTime() - 20_000, ruleId: 1 } };
  const result = await new DailyLimitManager(storage).recordSample(['2:study'], now);
  assert.deepEqual(result.state.usageSeconds, { '1': 100, '2:study': 120 });
  assert.deepEqual(result.state.lastSample.assignmentKeys, ['2:study']);
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
});

test('usage continuity midnight resets the old day while consuming a pending journal', async () => {
  const now = new Date(2026, 9, 4, 0, 0, 20);
  const storage = continuityStorage(now, { date: '2026-10-03' }); const manager = new DailyLimitManager(storage);
  assert.deepEqual((await manager.recordSample(['2:study'], now)).state.usageSeconds, {});
  assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
  assert.equal((await manager.recordSample(['2:study'], new Date(now.getTime() + 20_000))).state.usageSeconds['2:study'], 20);
});

test('usage continuity the existing accounting gap cap survives a pending remap', async () => {
  const now = new Date(2026, 9, 3, 12, 0, 20);
  const storage = continuityStorage(now); storage.data.dailyRuleUsage.lastSample.timestamp = now.getTime() - 120_000;
  const manager = new DailyLimitManager(storage);
  assert.equal((await manager.recordSample(['2:study'], now)).state.usageSeconds['2:study'], 100);
  assert.equal((await manager.recordSample(['2:study'], new Date(now.getTime() + 20_000))).state.usageSeconds['2:study'], 120);
});

function continuityPause() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), resolve: () => release() };
}

async function withContinuityClock(now, callback) {
  const NativeDate = globalThis.Date;
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  };
  try { return await callback(); }
  finally { globalThis.Date = NativeDate; }
}

for (const order of ['sample_before_stage', 'stage_before_sample']) {
  test(`usage continuity real storage awaits preserve time with ${order}`, { timeout: 5000 }, async () => {
    const start = new Date(2026, 9, 3, 12, 0, 0); const at20 = new Date(start.getTime() + 20_000);
    await withContinuityClock(start, async () => {
      const storage = createStorage({ dailyRuleUsage: { version: 2, date: getLocalDateKey(start), usageSeconds: { '1:study': 100, '1:general': 70 },
        lastSample: { timestamp: start.getTime(), assignmentKeys: ['1:study'] } } });
      const manager = new DailyLimitManager(storage); const entered = continuityPause(); const release = continuityPause();
      const get = storage.get.bind(storage); const set = storage.set.bind(storage); let gated = false;
      if (order === 'sample_before_stage') {
        storage.get = async keys => {
          const snapshot = structuredClone(await get(keys));
          if (!gated) { gated = true; entered.resolve(); await release.promise; }
          return snapshot;
        };
      } else {
        storage.set = async values => {
          if (!gated && Object.hasOwn(values, PENDING_DAILY_USAGE_REMAPS_KEY)) {
            gated = true; entered.resolve(); await release.promise;
          }
          return set(values);
        };
      }
      const remap = { oldRuleId: 1, oldListId: 'study', newRuleId: 2, newListId: 'study' };
      let sample; let stage;
      if (order === 'sample_before_stage') {
        sample = manager.recordSample(['1:study'], at20);
        await entered.promise;
        stage = manager.stagePendingRemaps({ rules: [{ id: 2 }] }, [remap]);
      } else {
        stage = manager.stagePendingRemaps({ rules: [{ id: 2 }] }, [remap]);
        await entered.promise;
        sample = manager.recordSample(['2:study'], at20);
      }
      release.resolve();
      await Promise.all([sample, stage]);
      const at25 = new Date(start.getTime() + 25_000);
      const result = await manager.recordSample(['2:study'], at25);
      assert.deepEqual(result.state.usageSeconds, { '2:study': 125, '1:general': 70 });
      assert.deepEqual(storage.data[PENDING_DAILY_USAGE_REMAPS_KEY], []);
      assert.equal((await manager.recoverPendingRemaps(at25)).recovered, false);
      assert.deepEqual(storage.data.rules, [{ id: 2 }]);
    });
  });
}
