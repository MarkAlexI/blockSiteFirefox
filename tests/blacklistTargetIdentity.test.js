import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesManager } from '../rules/rulesManager.js';
import { RuleListsManager } from '../rules/ruleListsManager.js';
import { createRuleAssignment, getRuleAssignment } from '../rules/ruleAssignments.js';
import { DailyLimitManager, getLocalDateKey } from '../rules/dailyLimitManager.js';
import { createRulesMutationService, serializeRulesMutationError } from '../rules/rulesMutationService.js';
import { createDnrSynchronizer } from '../scripts/dnrSynchronizer.js';
import { createDnrRuleFactory, createDnrUrlFilter } from '../rules/dnrRuleFactory.js';
import { isRuleActiveNow } from '../rules/ruleActivation.js';
import { doesUrlMatchBlockRule } from '../rules/urlRuleMatcher.js';

const SIMPLE = 'example.test/team';
const ALIAS = 'https://www.example.test:443/team/';
const lists = [
  { id: 'general', name: 'General', disabledCategories: [] },
  { id: 'list-1', name: 'Work', disabledCategories: [] },
  { id: 'list-2', name: 'Study', disabledCategories: [] }
];
const assignment = (listId = 'general', config = {}) => createRuleAssignment(listId, config);
const daily = (listId = 'general', config = {}) => assignment(listId, {
  blockingMode: 'daily_limit', dailyLimit: { minutes: 10 }, ...config
});
const row = (id, blockURL, assignments = [assignment()], extra = {}) => ({
  id, blockURL, redirectURL: '', category: 'social', isWhitelist: false, assignments, ...extra
});

// All policy, storage-revision, activation, compilation and usage-remap logic
// is production code. Only browser storage/DNR and external inputs are modeled.
function createHarness(t, initialRules = [], { usageSeconds = {}, activeListId = 'general',
  focusActive = false, access = { isPro: true }, packEntries = [] } = {}) {
  const state = structuredClone({
    rules: initialRules, ruleLists: lists, activeRuleListId: activeListId,
    rulesGeneration: 'initial-generation', ruleRevisions: {}, ruleListRevisions: {},
    dailyRuleUsage: { version: 2, date: getLocalDateKey(), usageSeconds, lastSample: null }
  });
  const writes = [], updates = [], notifications = [];
  let dynamicRules = [];
  const storage = {
    async get(keys, callback) {
      const selected = typeof keys === 'string' ? [keys] : keys;
      const result = structuredClone(Object.fromEntries(selected.map(key => [key, state[key]])));
      callback?.(result);
      return result;
    },
    async set(patch, callback) {
      writes.push(structuredClone(patch));
      Object.assign(state, structuredClone(patch));
      callback?.();
    }
  };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { storage: { local: storage }, runtime: {} };
  t.after(() => { globalThis.chrome = previousChrome; });
  const rulesManager = new RulesManager();
  const ruleListsManager = new RuleListsManager(storage);
  const dailyLimitManager = new DailyLimitManager(storage);
  const declarativeNetRequest = {
    async getDynamicRules() { return structuredClone(dynamicRules); },
    async updateDynamicRules(update) {
      updates.push(structuredClone(update));
      dynamicRules = dynamicRules.filter(rule => !update.removeRuleIds.includes(rule.id));
      dynamicRules.push(...structuredClone(update.addRules));
    }
  };
  const logger = { log() {}, warn() {}, error() {} };
  const synchronizer = createDnrSynchronizer({
    getRules: () => rulesManager.getRules(),
    getRuleListState: () => ruleListsManager.getState(),
    getDailyUsage: () => dailyLimitManager.getUsageSeconds(),
    getFocusSessionState: async () => ({ focusActive }),
    getAccess: async () => access,
    isRuleActiveNow,
    createDnrRule: createDnrRuleFactory(path => `https://extension.invalid/${path}`),
    closeTabsMatchingRules: async () => {}, declarativeNetRequest, logger
  });
  const service = createRulesMutationService({
    rulesManager, ruleListsManager, dailyLimitManager,
    dnrSynchronizer: synchronizer, declarativeNetRequest,
    getAccess: async () => access,
    getRulesGeneration: async () => state.rulesGeneration,
    getSettings: async () => ({}), saveSettings: async () => {},
    async saveRulesAndLists(rules, ruleLists, activeRuleListId, rulesGeneration) {
      await storage.set(await rulesManager.prepareRulesState(rules,
        await ruleListsManager.prepareState(ruleLists, activeRuleListId, { rulesGeneration })));
    },
    maxRulesLimit: 10, logger,
    notifyRulesChanged: (...args) => notifications.push(structuredClone(args)),
    resolveRulePackEntries: () => ({ pack: { category: 'social' }, entries: packEntries, invalidEntryIds: [] })
  });
  return {
    state, writes, updates, notifications, rulesManager, synchronizer,
    dynamicRules: () => structuredClone(dynamicRules),
    mutate(method, payload = {}) {
      return service[method]({
        expectedGeneration: state.rulesGeneration,
        expectedRevision: state.ruleRevisions[payload.ruleId] ?? null,
        expectedListRevision: state.ruleListRevisions[payload.listId] ?? null,
        expectedListRevisions: structuredClone(state.ruleListRevisions), ...payload
      });
    }
  };
}

async function rejectWithoutWrites(h, method, payload, code = 'rule_already_exists') {
  const before = structuredClone(h.state);
  const counts = [h.writes.length, h.updates.length, h.notifications.length];
  await assert.rejects(h.mutate(method, payload), error => error.code === code);
  assert.deepEqual(h.state, before, 'rejection preserves rules, revisions, lists and spent time');
  assert.deepEqual([h.writes.length, h.updates.length, h.notifications.length], counts);
}

const equivalentPairs = [
  [SIMPLE, ALIAS],
  [SIMPLE, 'http://www.example.test:80/team/'],
  [SIMPLE, 'example.test/old/../team/?ignored=yes#chapter'],
  ['bücher.test/team', 'https://xn--bcher-kva.test/team/'],
  ['example.test/тест', 'example.test/%D1%82%D0%B5%D1%81%D1%82'],
  ['[::1]:8443/team', 'https://[0:0:0:0:0:0:0:1]:8443/team/'],
  ['w', 'https://www.w:443/'],
  ['yout', 'YOUT/'],
  ['example.test^p:item|', 'EXAMPLE.TEST^P:ITEM|']
];

for (const [original, alias] of equivalentPairs) {
  for (const differentTarget of [false, true]) {
    test(`effective blacklist identity rejects ${alias}, different target=${differentTarget}`, async t => {
      const h = createHarness(t);
      await h.mutate('addRule', { blockURL: original, redirectURL: 'https://destination-a.test/', category: 'social' });
      assert.equal(createDnrUrlFilter(original).toLowerCase(), createDnrUrlFilter(alias).toLowerCase());
      await rejectWithoutWrites(h, 'addRule', { blockURL: alias,
        redirectURL: differentTarget ? 'https://destination-b.test/' : 'https://destination-a.test/',
        category: differentTarget ? 'work' : 'social' });
    });
  }
}

for (const [left, right] of [
  ['example.test:8443/team', 'example.test:9443/team'],
  ['example.test:8443/team', SIMPLE],
  ['example.test/a%2Fb', 'example.test/a/b'],
  ['example.test^p:item|', 'example.test^p:item'],
  ['example.test^p:item|', 'example.test^p:item?|'],
  ['example.test^p*item|', 'example.test^p:item|'],
  ['example.test/Ц', 'example.test/ц']
]) {
  test(`different compiled targets remain separate: ${left}, ${right}`, async t => {
    const h = createHarness(t);
    await h.mutate('addRule', { blockURL: left });
    await h.mutate('addRule', { blockURL: right });
    assert.equal(h.state.rules.length, 2);
    assert.notEqual(createDnrUrlFilter(left).toLowerCase(), createDnrUrlFilter(right).toLowerCase());
  });
}

test('short fragments retain domain-anchored runtime matching', async t => {
  const h = createHarness(t);
  await h.mutate('addRule', { blockURL: 'w' });
  await h.mutate('addRule', { blockURL: 'yout' });
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com/watch', 'yout'), true);
  assert.equal(doesUrlMatchBlockRule('https://other.test/path/yout', 'yout'), false);
  assert.equal(h.dynamicRules().some(rule => rule.condition.urlFilter === '||w'), true);
});

test('an equivalent target adds a disjoint assignment without replacing the saved spelling or budgets', async t => {
  const h = createHarness(t, [row(1, SIMPLE, [daily()])], { usageSeconds: { '1:general': 240 } });
  const result = await h.mutate('addRule', { blockURL: ALIAS, assignment: daily('list-1') });
  assert.equal(result.created, false);
  assert.equal(result.assignmentAdded, true);
  assert.equal(h.state.rules.length, 1);
  assert.equal(h.state.rules[0].id, 1);
  assert.equal(h.state.rules[0].blockURL, SIMPLE);
  assert.deepEqual(h.state.dailyRuleUsage.usageSeconds, { '1:general': 240 });
  assert.deepEqual(h.state.rules[0].assignments.map(item => item.listId), ['general', 'list-1']);
});

test('disabled equivalent variants retain settings and spent time, and cannot be enabled together', async t => {
  const h = createHarness(t, [row(1, SIMPLE, [daily()])], { usageSeconds: { '1:general': 120 } });
  await h.mutate('addRule', { blockURL: ALIAS, redirectURL: 'https://destination-b.test/',
    assignment: daily('general', { disabledByUser: true }) });
  const variantId = h.state.rules[1].id;
  h.state.dailyRuleUsage.usageSeconds[`${variantId}:general`] = 180;
  await rejectWithoutWrites(h, 'toggleRule', { ruleId: variantId, listId: 'general' });
  await h.mutate('toggleRule', { ruleId: 1, listId: 'general' });
  await h.mutate('toggleRule', { ruleId: variantId, listId: 'general' });
  assert.deepEqual(h.state.dailyRuleUsage.usageSeconds, { '1:general': 120, [`${variantId}:general`]: 180 });
  assert.equal(h.state.rules[1].blockURL, ALIAS);
});

for (const sourceListId of [null, 'general']) {
  test(`editing into an equivalent enabled target is rejected, source=${sourceListId}`, async t => {
    const h = createHarness(t, [row(1, SIMPLE), row(2, 'other.test')]);
    await rejectWithoutWrites(h, 'updateRule', { ruleId: 2, blockURL: ALIAS,
      redirectURL: 'https://destination-b.test/', assignmentListId: sourceListId });
  });
}

test('moving an equivalent enabled variant into an occupied list is rejected', async t => {
  const h = createHarness(t, [row(1, SIMPLE), row(2, ALIAS, [daily('list-1')],
    { redirectURL: 'https://destination-b.test/' })], { usageSeconds: { '2:list-1': 240 } });
  await rejectWithoutWrites(h, 'updateRule', { ruleId: 2, assignmentListId: 'list-1',
    assignment: daily('general') });
});

test('an equivalent spelling edit does not split a shared target or reset usage', async t => {
  const h = createHarness(t, [row(1, SIMPLE, [daily(), daily('list-1')])],
    { usageSeconds: { '1:general': 120, '1:list-1': 240 } });
  const result = await h.mutate('updateRule', { ruleId: 1, blockURL: ALIAS,
    assignmentListId: 'list-1', assignment: daily('list-1') });
  assert.equal(result.targetSplit, undefined);
  assert.equal(h.state.rules.length, 1);
  assert.equal(h.state.rules[0].id, 1);
  assert.deepEqual(h.state.dailyRuleUsage.usageSeconds, { '1:general': 120, '1:list-1': 240 });
});

test('explicitly moving to an equivalent existing target remaps spent usage durably', async t => {
  const h = createHarness(t, [row(1, SIMPLE, [daily()]), row(2, 'other.test', [daily('list-1')])],
    { usageSeconds: { '1:general': 120, '2:list-1': 240 } });
  const result = await h.mutate('updateRule', { ruleId: 2, blockURL: ALIAS,
    assignmentListId: 'list-1', assignment: daily('list-1') });
  assert.equal(result.targetMerged, true);
  assert.equal(h.state.rules.length, 1);
  assert.equal(h.state.rules[0].id, 1);
  assert.deepEqual(h.state.dailyRuleUsage.usageSeconds, { '1:general': 120, '1:list-1': 240 });
  assert.deepEqual(h.state.pendingDailyUsageRemaps, []);
  assert.equal(h.writes.some(patch => patch.rules && patch.pendingDailyUsageRemaps?.length === 1), true);
});

test('packs skip equivalent enabled targets and add a new target in the same batch', async t => {
  const h = createHarness(t, [row(1, ALIAS, [assignment()], { category: 'work' })], {
    packEntries: [{ id: 'existing', blockURL: SIMPLE }, { id: 'new', blockURL: 'fresh.test' }]
  });
  const result = await h.mutate('addMany', { packId: 'test', entryIds: ['existing', 'new'] });
  assert.equal(h.state.rules.length, 2);
  assert.equal(h.state.rules[0].blockURL, ALIAS);
  assert.equal(h.state.rules[1].blockURL, 'fresh.test');
  assert.equal(result.duplicateEntries.length, 1);
});

for (const reversed of [false, true]) {
  test(`import rejects equivalent enabled assignments atomically, reversed=${reversed}`, async t => {
    const h = createHarness(t, [row(3, 'preserve.test')], { usageSeconds: { '3:general': 200 } });
    const rules = [row(1, SIMPLE), row(2, ALIAS, [assignment()], { redirectURL: 'https://destination-b.test/' })];
    await rejectWithoutWrites(h, 'replaceAll', { rules: reversed ? rules.reverse() : rules, ruleLists: lists });
  });
}

test('import preserves disabled target variants and combines only disjoint equivalent assignments', async t => {
  const h = createHarness(t);
  await h.mutate('replaceAll', { ruleLists: lists, rules: [
    row(1, SIMPLE, [daily()]), row(2, ALIAS, [daily('list-1')]),
    row(3, ALIAS, [daily('general', { disabledByUser: true })], { redirectURL: 'https://destination-b.test/' })
  ] });
  assert.equal(h.state.rules.length, 2);
  assert.equal(h.state.rules[0].blockURL, SIMPLE);
  assert.deepEqual(h.state.rules[0].assignments.map(item => item.listId), ['general', 'list-1']);
  assert.equal(getRuleAssignment(h.state.rules[1], 'general').disabledByUser, true);
  await rejectWithoutWrites(h, 'toggleRule', { ruleId: h.state.rules[1].id, listId: 'general' });
});

for (const reversed of [false, true]) {
  test(`list deletion detects equivalent General collisions before remapping usage, reversed=${reversed}`, async t => {
    const rules = [row(1, SIMPLE, [daily()]), row(2, ALIAS, [daily('list-1')],
      { redirectURL: 'https://destination-b.test/' })];
    const h = createHarness(t, reversed ? rules.reverse() : rules,
      { usageSeconds: { '1:general': 120, '2:list-1': 240 } });
    await rejectWithoutWrites(h, 'deleteRuleList', { listId: 'list-1' });
    try { await h.mutate('deleteRuleList', { listId: 'list-1' }); }
    catch (error) {
      assert.deepEqual(serializeRulesMutationError(error).conflict, { listId: 'general', blockURL: ALIAS });
    }
  });
}

for (const reversed of [false, true]) {
  test(`Focus deduplicates compiled aliases with active profile preference, reversed=${reversed}`, async t => {
    const rules = [row(1, SIMPLE), row(2, ALIAS, [assignment('list-1')],
      { redirectURL: 'https://destination-b.test/' })];
    const h = createHarness(t, reversed ? rules.reverse() : rules,
      { activeListId: 'list-1', focusActive: true, usageSeconds: { '1:general': 100 } });
    const before = structuredClone(h.state);
    assert.equal((await h.synchronizer.requestSync()).success, true);
    assert.deepEqual(h.dynamicRules().map(rule => rule.id), [2]);
    assert.equal(new URL(h.dynamicRules()[0].action.redirect.url).searchParams.get('to'), 'https://destination-b.test/');
    assert.equal(h.dynamicRules()[0].condition.urlFilter, '||example.test/team');
    assert.deepEqual(h.state, before, 'reading legacy aliases never rewrites stored rows or budgets');
    assert.equal(h.writes.length, 0);
  });
}

test('Free Focus still chooses General when the selected profile has an equivalent target', async t => {
  const h = createHarness(t, [row(1, ALIAS, [assignment('list-1')]), row(2, SIMPLE)],
    { activeListId: 'list-1', focusActive: true, access: { isPro: false, isLegacyUser: false } });
  assert.equal((await h.synchronizer.requestSync()).success, true);
  assert.deepEqual(h.dynamicRules().map(rule => rule.id), [2]);
});

test('Focus reports invalid stored targets separately while deduplicating valid aliases', async t => {
  const h = createHarness(t, [row(1, 'www.'), row(2, { toString: null }), row(3, SIMPLE), row(4, ALIAS)],
    { focusActive: true });
  const before = structuredClone(h.state);
  const result = await h.synchronizer.requestSync();
  assert.equal(result.success, false);
  assert.equal(result.invalidRuleCount, 2);
  assert.deepEqual(h.dynamicRules().map(rule => rule.id), [3]);
  assert.deepEqual(h.state, before);
});

test('whitelist retains its own target language and raw conflict checks', async t => {
  const h = createHarness(t);
  await h.mutate('addRule', { blockURL: 'bücher.test/team', isWhitelist: true });
  await h.mutate('addRule', { blockURL: 'xn--bcher-kva.test/team', isWhitelist: true });
  assert.equal(h.state.rules.length, 2);
  assert.equal(h.dynamicRules().length, 0);
});

test('concurrent aliases share the mutation queue and only one enabled target is saved', async t => {
  const h = createHarness(t);
  const results = await Promise.allSettled([
    h.mutate('addRule', { blockURL: SIMPLE }),
    h.mutate('addRule', { blockURL: ALIAS, redirectURL: 'https://destination-b.test/' })
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'rule_already_exists');
  assert.equal(h.state.rules.length, 1);
  assert.equal(h.writes.length, 1);
});

test('legacy equivalent rows remain separate until the user explicitly disables or repairs one', async t => {
  const h = createHarness(t, [row(1, SIMPLE, [daily()]), row(2, ALIAS, [daily()],
    { redirectURL: 'https://destination-b.test/' })], { usageSeconds: { '1:general': 600, '2:general': 700 } });
  const before = structuredClone(h.state);
  assert.equal((await h.synchronizer.requestSync()).success, true);
  assert.deepEqual(h.state, before);
  assert.equal(h.dynamicRules().length, 2, 'normal-mode legacy winner policy is a separate increment');
  await h.mutate('toggleRule', { ruleId: 2, listId: 'general' });
  assert.equal(h.state.rules.length, 2);
  assert.deepEqual(h.state.rules[0], before.rules[0]);
  assert.deepEqual(h.state.dailyRuleUsage, before.dailyRuleUsage);
  assert.deepEqual(h.dynamicRules().map(rule => rule.id), [1]);
});

test('deleting a list preserves a disabled equivalent variant and remaps only its own spent time', async t => {
  const h = createHarness(t, [row(1, SIMPLE, [daily()]), row(2, ALIAS,
    [daily('list-1', { disabledByUser: true })], { redirectURL: 'https://destination-b.test/' })],
    { usageSeconds: { '1:general': 120, '2:list-1': 240 } });
  await h.mutate('deleteRuleList', { listId: 'list-1' });
  assert.equal(h.state.rules.length, 2);
  assert.equal(h.state.rules[1].blockURL, ALIAS);
  assert.equal(getRuleAssignment(h.state.rules[1], 'general').disabledByUser, true);
  assert.deepEqual(h.state.dailyRuleUsage.usageSeconds, { '1:general': 120, '2:general': 240 });
  assert.deepEqual(h.state.pendingDailyUsageRemaps, []);
});

test('Focus retains distinct Unicode paths instead of deduplicating their unencoded lowercase text', async t => {
  const h = createHarness(t, [row(1, 'example.test/Ц'), row(2, 'example.test/ц')], { focusActive: true });
  assert.equal((await h.synchronizer.requestSync()).success, true);
  assert.deepEqual(h.dynamicRules().map(rule => rule.id), [1, 2]);
});
