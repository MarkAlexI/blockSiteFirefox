import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyLimitManager, getLocalDateKey } from '../rules/dailyLimitManager.js';
import { createRulesMigrationService, migrateDailyUsageSchema } from '../rules/rulesMigrationService.js';
import { getAssignmentUsageSeconds } from '../rules/ruleAssignments.js';

const start = new Date(2026, 9, 2, 12, 0);
const daily = (listId = 'general') => ({ listId, disabledByUser: false,
  blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 10 } });
const rules = [{ id: 21, blockURL: 'usage.example', redirectURL: '', isWhitelist: false,
  category: 'social', assignments: [daily(), daily('study')] }];
function storage(initial) {
  const data = structuredClone(initial);
  return { data, writes: [],
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]));
    },
    async set(values) { this.writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); }
  };
}
function migration(local, manager) {
  return createRulesMigrationService({ localStorage: local, syncStorage: storage({}), dailyLimitManager: manager,
    rulesManager: { getRules: async () => structuredClone(rules), saveRules: async next => local.set({ rules: next }) },
    logger: { log() {}, info() {}, error() {} } });
}
function legacy(seconds = 100) {
  return { version: 1, date: getLocalDateKey(start), usageSeconds: { '21': seconds },
    lastSample: { timestamp: start.getTime(), ruleId: 21 } };
}

test('mixed legacy and assignment usage migration preserves the larger elapsed time for every profile', () => {
  const result = migrateDailyUsageSchema({ ...legacy(840), usageSeconds: { '21': 840,
    '21:general': 10, '21:study': 900 } }, rules);
  assert.deepEqual(result.state.usageSeconds, { '21:general': 840, '21:study': 900 });
});

test('backward-compatible usage reads never prefer a smaller assignment value over legacy elapsed time', () => {
  assert.equal(getAssignmentUsageSeconds({ '21': 840, '21:general': 10 }, 21, 'general'), 840);
  assert.equal(getAssignmentUsageSeconds({ '21': 840, '21:general': 900 }, 21, 'general'), 900);
});

for (const closePreviousSegment of [false, true]) {
  test(`accounting before startup migration keeps legacy time plus new segments with boundary ${closePreviousSegment}`, async () => {
    const local = storage({ dailyRuleUsage: legacy() });
    const manager = new DailyLimitManager(local);
    await manager.recordSample(['21:general'], new Date(start.getTime() + 10_000), { closePreviousSegment });
    await manager.recordSample(['21:general'], new Date(start.getTime() + 20_000));
    const result = await migration(local, manager).migrateDailyUsage(rules);
    assert.equal(result.state.usageSeconds['21:general'], 120);
    assert.equal(local.data.dailyRuleUsage.usageSeconds['21:general'], 120);
    assert.equal(result.state.usageSeconds['21:study'] >= 100, true);
    assert.deepEqual(result.state.lastSample.assignmentKeys, ['21:general']);
  });
}

test('normalization before migration preserves the numeric legacy active segment', async () => {
  const local = storage({ dailyRuleUsage: legacy() });
  const manager = new DailyLimitManager(local);
  await manager.readState(start);
  await migration(local, manager).migrateDailyUsage(rules);
  const result = await manager.recordSample(['21:general', '21:study'], new Date(start.getTime() + 10_000));
  assert.deepEqual(result.state.usageSeconds, { '21:general': 110, '21:study': 110 });
  assert.deepEqual(result.state.lastSample.assignmentKeys, ['21:general', '21:study']);
});


for (const phase of ['queued', 'reading']) {
  test(`superseded accounting during ${phase} storage await leaves the remapped segment intact`, async () => {
    const initial = { version: 2, date: getLocalDateKey(start), usageSeconds: { '1:study': 100 },
      lastSample: { timestamp: start.getTime(), assignmentKeys: ['1:study'] } };
    const local = storage({ dailyRuleUsage: initial });
    let release;
    let ready;
    const held = new Promise(resolve => { release = resolve; });
    const captured = new Promise(resolve => { ready = resolve; });
    const originalGet = local.get.bind(local);
    let first = true;
    local.get = async keys => {
      const snapshot = await originalGet(keys);
      if (first) { first = false; ready(); await held; }
      return snapshot;
    };
    const manager = new DailyLimitManager(local);
    let current = true;
    const before = phase === 'queued' ? manager.readState(start) : null;
    if (before) await captured;
    const sample = manager.recordSample(['21:study'], new Date(start.getTime() + 10_000), { shouldContinue: () => current });
    await captured;
    current = false;
    release();
    if (before) await before;
    assert.equal((await sample).superseded, true);
    assert.deepEqual(local.data.dailyRuleUsage, initial);
    assert.deepEqual(local.writes, []);
    const next = await manager.recordSample(['1:study'], new Date(start.getTime() + 20_000));
    assert.equal(next.state.usageSeconds['1:study'], 120);
    assert.equal(next.state.usageSeconds['21:study'], undefined);
  });
}

test('pruning retains legacy usage only for rules with a surviving daily assignment', async () => {
  const local = storage({ dailyRuleUsage: { ...legacy(840), usageSeconds: { '21': 840, '22': 900, '22:study': 900 } } });
  await new DailyLimitManager(local).pruneAssignmentKeys(['21:general'], start);
  assert.deepEqual(local.data.dailyRuleUsage.usageSeconds, { '21': 840 });
  assert.deepEqual(local.data.dailyRuleUsage.lastSample.assignmentKeys, ['21']);
});


test('a split before legacy migration journals and transfers the exhausted source budget', async () => {
  const now = new Date();
  const local = storage({ rules, dailyRuleUsage: { ...legacy(840), date: getLocalDateKey(now),
    lastSample: { timestamp: now.getTime(), ruleId: 21 } } });
  const manager = new DailyLimitManager(local);
  const remap = { oldRuleId: 21, oldListId: 'study', newRuleId: 1, newListId: 'study' };
  await manager.stagePendingRemaps({ rules: [{ ...rules[0], assignments: [daily()] },
    { ...rules[0], id: 1, assignments: [daily('study')] }] }, [remap]);
  assert.deepEqual(local.data.pendingDailyUsageRemaps, [remap]);
  await manager.recoverPendingRemaps(now);
  assert.equal(local.data.dailyRuleUsage.usageSeconds['1:study'], 840);
  assert.equal(local.data.dailyRuleUsage.usageSeconds['21'], 840);
  assert.deepEqual(local.data.dailyRuleUsage.lastSample.assignmentKeys, ['21', '1:study']);
  assert.deepEqual(local.data.pendingDailyUsageRemaps, []);
});
