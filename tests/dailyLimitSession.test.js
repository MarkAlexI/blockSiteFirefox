import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyLimitManager, getLocalDateKey } from '../rules/dailyLimitManager.js';

const now = new Date(2026, 9, 13, 12, 40, 14, 427);
const sessionKey = 'dailyLimitSession';
function storage(initial = {}) {
  return { data: structuredClone(initial), error: null,
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .filter(key => Object.hasOwn(this.data, key)).map(key => [key, structuredClone(this.data[key])])); },
    async set(patch) { if (this.error) throw this.error; Object.assign(this.data, structuredClone(patch)); } };
}
function fixture() {
  const local = storage({ dailyRuleUsage: { version: 2, date: getLocalDateKey(now),
    usageSeconds: { '21:general': 40, '23:general': 15 },
    lastSample: { timestamp: now.getTime() - 11128, assignmentKeys: ['21:general'] } } });
  const session = storage();
  return { local, session, manager: new DailyLimitManager(local, { sessionStorage: session }) };
}

test('first tab event after a browser restart cannot charge the previous browser lifetime', async () => {
  const { local, session, manager } = fixture();
  const first = await manager.recordSample(['21:general'], now, { closePreviousSegment: true });
  assert.equal(first.addedSeconds, 0);
  assert.deepEqual(local.data.dailyRuleUsage.usageSeconds, { '21:general': 40, '23:general': 15 });
  assert.deepEqual(local.data.dailyRuleUsage.lastSample, { timestamp: now.getTime(), assignmentKeys: ['21:general'] });
  assert.equal(session.data[sessionKey], 1);
  const next = await manager.recordSample(['21:general'], new Date(now.getTime() + 2200));
  assert.equal(next.addedSeconds, 2);
  assert.equal(next.state.usageSeconds['21:general'], 42);
  assert.equal(next.state.usageSeconds['23:general'], 15);
});

test('automatic worker replacement keeps an existing browser session accounting segment', async () => {
  const { local, session, manager } = fixture();
  await manager.recordSample(['21:general'], now);
  const replacement = new DailyLimitManager(local, { sessionStorage: session });
  const next = await replacement.recordSample(['21:general'], new Date(now.getTime() + 7000));
  assert.equal(next.addedSeconds, 7);
  assert.equal(next.state.usageSeconds['21:general'], 47);
});

test('a new browser lifetime is detected even by the same manager object', async () => {
  const { local, session, manager } = fixture();
  await manager.recordSample(['21:general'], now);
  // A worker normally dies with Chrome; clearing session storage also covers
  // a background lifetime retained by a different browser implementation.
  session.data = {};
  const next = await manager.recordSample(['21:general'], new Date(now.getTime() + 8000));
  assert.equal(next.addedSeconds, 0);
  assert.equal(local.data.dailyRuleUsage.usageSeconds['21:general'], 40);
});

test('an initial pause discards only the old segment and retains remapped usage', async () => {
  const { local, manager } = fixture();
  local.data.pendingDailyUsageRemaps = [{ oldRuleId: 21, oldListId: 'general', newRuleId: 24, newListId: 'list-1' }];
  const result = await manager.resetSample(now);
  assert.equal(result.addedSeconds, 0);
  assert.deepEqual(result.state.usageSeconds, { '24:list-1': 40, '23:general': 15 });
  assert.deepEqual(local.data.pendingDailyUsageRemaps, []);
  assert.equal(result.state.lastSample, null);
});

test('a failed durable boundary cannot mark the session as ready or charge offline time on retry', async () => {
  const { local, session, manager } = fixture();
  const original = structuredClone(local.data);
  local.error = new Error('local write failed');
  await assert.rejects(manager.recordSample(['21:general'], now), /local write failed/);
  assert.deepEqual(local.data, original);
  assert.equal(session.data[sessionKey], undefined);
  local.error = null;
  const result = await manager.recordSample(['21:general'], now);
  assert.equal(result.addedSeconds, 0);
  assert.equal(result.state.usageSeconds['21:general'], 40);
});

test('session storage failure stops accounting and cannot reuse a stale durable segment', async () => {
  const { local, session, manager } = fixture();
  session.error = new Error('session write failed');
  await assert.rejects(manager.recordSample(['21:general'], now), /session write failed/);
  assert.equal(local.data.dailyRuleUsage.lastSample, null);
  assert.equal(local.data.dailyRuleUsage.usageSeconds['21:general'], 40);
  session.error = null;
  const retry = new DailyLimitManager(local, { sessionStorage: session });
  assert.equal((await retry.recordSample(['21:general'], now)).addedSeconds, 0);
});

test('legacy browser startup boundary preserves exact v1 counters and the durable remap journal', async () => {
  const { local } = fixture();
  local.data.dailyRuleUsage = { version: 1, date: getLocalDateKey(now), usageSeconds: { '21': 840 },
    lastSample: { timestamp: now.getTime() - 8000, ruleId: 21 } };
  local.data.pendingDailyUsageRemaps = [{ oldRuleId: 21, oldListId: 'general', newRuleId: 24, newListId: 'list-1' }];
  const journal = structuredClone(local.data.pendingDailyUsageRemaps);
  const manager = new DailyLimitManager(local);
  await manager.discardLastSample();
  assert.deepEqual(local.data.dailyRuleUsage, { version: 1, date: getLocalDateKey(now), usageSeconds: { '21': 840 }, lastSample: null });
  assert.deepEqual(local.data.pendingDailyUsageRemaps, journal);
});
