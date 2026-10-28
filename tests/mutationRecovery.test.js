import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installMutationProbe, readMutationProbe, releaseMutationProbe, restoreMutationProbe } from '../e2e/mutation-probes.mjs';
import { assertInterruptedRemap, assertRecoveredRemap } from '../e2e/mutation-recovery-scenarios.mjs';
import { assertSentinelHistory } from '../e2e/mutation-navigation.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const daily = listId => ({ listId, disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 10 } });
const stored = (phase = 'journal') => ({
  __bdInterruptionMarker: 'test-marker',
  rules: [{ id: 21, blockURL: 'old.test', assignments: [daily('general')] },
    { id: 1, blockURL: 'split.test', assignments: [daily('list-1')] }, { id: 24, blockURL: 'unrelated.test' }],
  dailyRuleUsage: { usageSeconds: { '21:general': 100, '24:general': 77, [phase === 'journal' ? '21:list-1' : '1:list-1']: 840 } },
  pendingDailyUsageRemaps: phase === 'journal' ? [{ oldRuleId: 21, oldListId: 'list-1', newRuleId: 1, newListId: 'list-1' }] : []
});
function realm(local = stored()) {
  let rules = [], nativeCalls = 0;
  const area = { async set(patch) { Object.assign(local, structuredClone(patch)); return 'native-storage-result'; },
    async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(local, key)).map(key => [key, structuredClone(local[key])])); } };
  const dnr = { async getDynamicRules() { return structuredClone(rules); },
    async updateDynamicRules(update) { nativeCalls++; rules = update.addRules; return 'native-dnr-result'; } };
  const view = { browser: { storage: { local: area }, declarativeNetRequest: dnr }, Date, Promise };
  const call = (fn, input) => vm.runInNewContext(`(${fn.toString()})(view, input)`, { view, input, structuredClone, URL });
  return { local, area, dnr, view, call, nativeCalls: () => nativeCalls, read: () => clone(call(readMutationProbe)) };
}

for (const phase of ['journal', 'remapped']) test(`${phase} gate holds only delivery of a real completed storage write`, async () => {
  const e = realm(stored());
  const original = e.area.set;
  e.call(installMutationProbe, { phase, token: 'test-marker', expectedHost: 'split.test' });
  const patch = phase === 'journal' ? { rules: stored().rules, pendingDailyUsageRemaps: stored().pendingDailyUsageRemaps }
    : { dailyRuleUsage: stored('remapped').dailyRuleUsage, pendingDailyUsageRemaps: [] };
  let replied = false;
  const pending = e.area.set(patch).then(value => { replied = true; return value; });
  for (let count = 0; count < 10 && !e.read().ready; count++) await tick();
  const observed = e.read();
  assert.equal(observed.ready, true); assert.equal(replied, false);
  assert.deepEqual(observed.entered.values, patch);
  assertInterruptedRemap(observed.entered.local, { phase, token: 'test-marker', splitHost: 'split.test' });
  e.call(releaseMutationProbe);
  assert.equal(await pending, 'native-storage-result');
  e.call(restoreMutationProbe); assert.equal(e.area.set, original);
});

test('the DNR gate surrounds the native call and retains its actual result and commit history', async () => {
  const e = realm();
  e.call(installMutationProbe, { phase: 'dnr', token: 't', expectedHost: 'new.test' });
  const update = { removeRuleIds: [1], addRules: [{ id: 1, action: { redirect: { url: 'chrome-extension://id/blocked.html?url=new.test' } } }] };
  let replied = false;
  const pending = e.dnr.updateDynamicRules(update).then(value => { replied = true; return value; });
  await tick(); assert.equal(e.nativeCalls(), 0); assert.equal(e.read().ready, true);
  e.call(releaseMutationProbe);
  await tick(); assert.equal(e.nativeCalls(), 1); assert.equal(replied, false);
  assert.deepEqual(e.read().committed.rules, update.addRules);
  e.call(releaseMutationProbe); assert.equal(await pending, 'native-dnr-result');
  e.call(restoreMutationProbe);
});

test('unrelated DNR updates cannot claim the selected production gate', async () => {
  const e = realm();
  e.call(installMutationProbe, { phase: 'dnr', token: 't', expectedHost: 'new.test' });
  await e.dnr.updateDynamicRules({ addRules: [] });
  assert.equal(e.read().ready, false); assert.equal(e.read().entered, null);
  e.call(restoreMutationProbe);
});

test('restoring a held pre-commit probe lets the native call finish without creating a second orphaned gate', async () => {
  const e = realm();
  const native = e.dnr.updateDynamicRules;
  e.call(installMutationProbe, { phase: 'dnr', token: 't' });
  let result;
  const pending = e.dnr.updateDynamicRules({ addRules: [] }).then(value => { result = value; });
  await tick(); assert.equal(e.nativeCalls(), 0);
  e.call(restoreMutationProbe);
  await tick();
  assert.equal(result, 'native-dnr-result');
  assert.equal(e.dnr.updateDynamicRules, native); assert.equal(e.view.__bdMutationProbe, undefined);
  await pending;
});

test('native storage and DNR failures remain failures rather than successful checkpoint evidence', async () => {
  const e = realm();
  e.area.set = async () => { throw new Error('disk full'); };
  e.call(installMutationProbe, { phase: 'journal', token: 't' });
  await assert.rejects(e.area.set({ rules: [], pendingDailyUsageRemaps: [{ oldRuleId: 21, oldListId: 'list-1' }] }), /disk full/);
  assert.equal(e.read().ready, false); e.call(restoreMutationProbe);
  e.dnr.updateDynamicRules = async () => { throw new Error('native quota'); };
  e.call(installMutationProbe, { phase: 'dnr', token: 't' });
  const result = e.dnr.updateDynamicRules({ addRules: [] }).then(() => null, error => error);
  await tick(); e.call(releaseMutationProbe);
  assert.match((await result).message, /native quota/); assert.equal(e.read().committed, null);
  e.call(restoreMutationProbe);
});

test('recovery oracle rejects a fresh budget, retained source key, lost unrelated budget and repeated remap', () => {
  const expected = assertInterruptedRemap(stored(), { phase: 'journal', token: 'test-marker', splitHost: 'split.test' });
  const checkpoint = { ...stored(), activeRuleListId: 'list-1', credentials: { isPro: true }, rulesGeneration: 'stable' };
  const recovered = { ...clone(checkpoint), dailyRuleUsage: { usageSeconds: expected.usage }, pendingDailyUsageRemaps: [], dnr: [{ id: 1 }] };
  assertRecoveredRemap(recovered, checkpoint, expected);
  for (const damage of [
    state => { state.dailyRuleUsage.usageSeconds['1:list-1'] = 0; },
    state => { state.dailyRuleUsage.usageSeconds['21:list-1'] = 840; },
    state => { delete state.dailyRuleUsage.usageSeconds['24:general']; },
    state => { state.dailyRuleUsage.usageSeconds['1:list-1'] = 1680; },
    state => { state.pendingDailyUsageRemaps = stored().pendingDailyUsageRemaps; },
    state => { state.rulesGeneration = 'reseeded'; }, state => { state.dnr = []; }
  ]) {
    const broken = clone(recovered); damage(broken);
    assert.throws(() => assertRecoveredRemap(broken, checkpoint, expected));
  }
});

test('a final repaired DNR set cannot erase an earlier commit that dropped the unchanged sentinel', () => {
  const sentinel = { action: { redirect: { url: 'chrome-extension://id/blocked.html?url=sentinel.test&reason=always' } } };
  const evidence = { overflow: false, entered: { before: [sentinel] }, committed: { rules: [sentinel] },
    events: [{ type: 'dnr-committed', rules: [sentinel] }] };
  assertSentinelHistory(evidence, 'sentinel.test');
  const broken = clone(evidence); broken.events.unshift({ type: 'dnr-committed', rules: [] });
  assert.throws(() => assertSentinelHistory(broken, 'sentinel.test'), /dropped the unchanged sentinel/);
});
