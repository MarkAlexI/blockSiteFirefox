import test from 'node:test';
import assert from 'node:assert/strict';
import { assignDnrRulePriorities, createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { createDnrSynchronizer, buildDnrDiff } from '../scripts/dnrSynchronizer.js';
import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';
import { isRuleActiveNow } from '../rules/ruleActivation.js';
import { createRuleAssignment } from '../rules/ruleAssignments.js';
import { DailyLimitManager, getLocalDateKey } from '../rules/dailyLimitManager.js';
import { createDailyLimitTracker } from '../rules/dailyLimitTracker.js';

const assignment = (listId = 'general', config = {}) => createRuleAssignment(listId, config);
const row = (id, blockURL, destination, assignments = [assignment()]) => ({
  id, blockURL, redirectURL: destination ? `https://destination.test/${destination}` : '',
  category: 'social', isWhitelist: false, assignments
});

function harness(initialRules, { focusActive = false, activeRuleListId = 'general',
  access = { isPro: true }, usageSeconds = {} } = {}) {
  const state = { rules: structuredClone(initialRules), focusActive, activeRuleListId,
    dailyRuleUsage: { version: 2, date: getLocalDateKey(), usageSeconds, lastSample: null } };
  let dynamicRules = [];
  const updates = [], writes = [];
  const storage = {
    async get(keys) {
      return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]])));
    },
    async set(patch) { writes.push(structuredClone(patch)); Object.assign(state, structuredClone(patch)); }
  };
  const usage = new DailyLimitManager(storage);
  const getRules = async () => structuredClone(state.rules);
  const getRuleListState = async () => ({ activeRuleListId: state.activeRuleListId,
    lists: ['general', 'list-1', 'list-2'].map(id => ({ id, disabledCategories: [] })) });
  const getFocusSessionState = async () => ({ focusActive: state.focusActive });
  const create = () => createDnrSynchronizer({
    getRules, getRuleListState, getFocusSessionState,
    getDailyUsage: () => usage.getUsageSeconds(), getAccess: async () => access,
    isRuleActiveNow, createDnrRule: createDnrRuleFactory(path => `https://extension.invalid/${path}`),
    closeTabsMatchingRules: async () => {}, logger: { log() {}, warn() {}, error() {} },
    declarativeNetRequest: {
      async getDynamicRules() { return structuredClone(dynamicRules); },
      async updateDynamicRules(update) {
        updates.push(structuredClone(update));
        dynamicRules = dynamicRules.filter(rule => !update.removeRuleIds.includes(rule.id));
        dynamicRules.push(...structuredClone(update.addRules));
      }
    }
  });
  const tracker = url => createDailyLimitTracker({
    tabsApi: { async query() { return [{ id: 12, windowId: 3, active: true, url }]; } },
    scriptingApi: { async executeScript() { return [{ frameId: 0,
      result: { visibilityState: 'visible', hidden: false, hasFocus: true } }]; } },
    getRules, getRuleListState, getFocusSessionState, dailyLimitManager: usage,
    dnrSynchronizer: { requestSync: async () => {} }, logger: { info() {} }
  });
  return { state, create, tracker, updates, writes, rules: () => structuredClone(dynamicRules) };
}

// This checks the emitted configuration against the real runtime matcher.
// Actual network navigation is tested separately by native scenario 89.
async function expectWinner(h, sync, url, winnerId) {
  assert.equal((await sync.requestSync()).success, true);
  const matching = h.rules().filter(dnr => doesUrlMatchBlockRule(url,
    h.state.rules.find(rule => rule.id === dnr.id).blockURL));
  assert.ok(matching.length > 1, 'positive control: more than one filter matches');
  const highest = Math.max(...matching.map(rule => rule.priority));
  const winners = matching.filter(rule => rule.priority === highest);
  assert.deepEqual(winners.map(rule => rule.id), [winnerId], 'native DNR has one explicit winner');
  assert.equal((await sync.resolveNavigation(url)).redirectUrl, winners[0].action.redirect.url);
  return winners[0];
}

for (const reverse of [false, true]) {
  test(`longer compiled filter wins independently of stored order (${reverse})`, async () => {
    const rules = [row(99, 'example.test/team', 'broad'), row(1, 'example.test/team/item', 'narrow')];
    const h = harness(reverse ? rules.reverse() : rules);
    const before = structuredClone(h.state);
    const url = 'https://example.test/team/item/next';
    assert.equal(findBestMatchingRule(url, h.state.rules).id, 1);
    const sync = h.create();
    const winner = await expectWinner(h, sync, url, 1);
    assert.equal(new URL(winner.action.redirect.url).searchParams.get('to'), 'https://destination.test/narrow');
    assert.deepEqual(h.state, before);
    assert.deepEqual(h.writes, []);
    assert.equal((await sync.requestSync()).changed, false, 'same snapshot needs no DNR write');
    assert.equal(h.updates.length, 1);
  });
}

for (const reverse of [false, true]) {
  test(`equal filter lengths prefer first stored target, not numeric ID (${reverse})`, async () => {
    const rules = [row(99, 'example.test/a*b', 'first'), row(1, 'example.test/ab*', 'second')];
    const h = harness(reverse ? rules.reverse() : rules);
    const url = 'https://example.test/ab/next';
    assert.equal(findBestMatchingRule(url, h.state.rules).id, h.state.rules[0].id);
    await expectWinner(h, h.create(), url, h.state.rules[0].id);
  });
}

test('legacy compiled aliases use first stored target without merging saved rows or spent budgets', async () => {
  const h = harness([row(99, 'example.test/team', 'first'),
    row(1, 'https://www.example.test:443/team/', 'second')], { usageSeconds: { '99:general': 40, '1:general': 80 } });
  const before = structuredClone(h.state);
  await expectWinner(h, h.create(), 'https://example.test/team/next', 99);
  assert.deepEqual(h.state, before);
  assert.deepEqual(h.writes, []);
});

test('reordering ties changes priorities atomically and restart preserves the new winner', async () => {
  const h = harness([row(99, 'example.test/a*b', 'first'), row(1, 'example.test/ab*', 'second')]);
  const sync = h.create(), url = 'https://example.test/ab/next';
  await expectWinner(h, sync, url, 99);
  const original = h.rules();
  h.state.rules.reverse();
  await expectWinner(h, sync, url, 1);
  const diff = buildDnrDiff(original, h.rules());
  assert.deepEqual([...diff.removeRuleIds].sort((a, b) => a - b), [1, 99]);
  assert.deepEqual(diff.addRules.map(rule => rule.id).sort((a, b) => a - b), [1, 99]);
  assert.deepEqual(h.updates[1], diff, 'priority changes use the existing atomic diff');
  await expectWinner(h, h.create(), url, 1);
  assert.equal(h.updates.length, 2, 'a new synchronizer does not rewrite already-correct priorities');
});

test('only valid active entries occupy priority ranks while corrupt rows remain saved', async () => {
  const disabled = row(8, 'example.test/team/disabled', 'disabled', [assignment('general', { disabledByUser: true })]);
  const inactive = row(9, 'example.test/team/inactive', 'inactive', [assignment('list-1')]);
  const h = harness([row(7, 'www.', 'invalid'), disabled, inactive,
    row(99, 'example.test/team', 'broad'), row(1, 'example.test/team/item', 'narrow')]);
  const before = structuredClone(h.state);
  const sync = h.create(), result = await sync.requestSync();
  assert.equal(result.success, false);
  assert.equal(result.invalidRuleCount, 1);
  assert.deepEqual(h.rules().map(rule => rule.id), [99, 1]);
  assert.deepEqual(h.rules().map(rule => rule.priority), [100, 101]);
  assert.deepEqual(h.state, before);
});

for (const reverse of [false, true]) {
  test(`Focus keeps active-profile alias preference before ranking overlaps (${reverse})`, async () => {
    const rules = [row(99, 'example.test/team', 'general'),
      row(1, 'https://www.example.test:443/team/', 'profile', [assignment('list-1')]),
      row(5, 'example.test/team/item', 'narrow', [assignment('list-2')])];
    const h = harness(reverse ? rules.reverse() : rules, { focusActive: true, activeRuleListId: 'list-1' });
    const before = structuredClone(h.state), sync = h.create();
    await sync.requestSync();
    assert.deepEqual(h.rules().map(rule => rule.id).sort((a, b) => a - b), [1, 5]);
    assert.equal(new URL((await sync.resolveNavigation('https://example.test/team/other')).redirectUrl)
      .searchParams.get('to'), 'https://destination.test/profile');
    await expectWinner(h, sync, 'https://example.test/team/item/next', 5);
    h.state.focusActive = false;
    await sync.requestSync();
    assert.deepEqual(h.rules().map(rule => rule.id), [1]);
    assert.equal(h.rules()[0].priority, 100);
    assert.deepEqual({ ...h.state, focusActive: true }, before);
  });
}

test('Free Focus does not introduce priorities or rules from paid profiles', async () => {
  const h = harness([row(99, 'example.test/team', 'general'),
    row(1, 'example.test/team/item', 'paid', [assignment('list-1')])],
    { focusActive: true, activeRuleListId: 'list-1', access: { isPro: false, isLegacyUser: false } });
  await h.create().requestSync();
  assert.deepEqual(h.rules().map(rule => [rule.id, rule.priority]), [[99, 100]]);
});

for (const reverse of [false, true]) {
  test(`Daily Limit attribution and exhausted native rules share the longest-filter winner (${reverse})`, async () => {
    const daily = [assignment('general', { blockingMode: 'daily_limit', dailyLimit: { minutes: 1 } })];
    const rules = [row(99, 'example.test/team', 'broad', daily), row(1, 'example.test/team/item', 'narrow', daily)];
    const h = harness(reverse ? rules.reverse() : rules);
    const url = 'https://example.test/team/item/next';
    const tracked = await h.tracker(url).resolveActiveDailyLimitRule();
    assert.equal(tracked.id, 1);
    assert.deepEqual(tracked.assignments.map(item => item.listId), ['general']);
    h.state.dailyRuleUsage.usageSeconds = { '99:general': 60, '1:general': 80 };
    const before = structuredClone(h.state);
    await expectWinner(h, h.create(), url, tracked.id);
    assert.deepEqual(h.state, before);
  });
}

test('single and empty active sets retain the existing base priority and clearing behavior', async () => {
  const h = harness([row(1, 'yout', '')]);
  const sync = h.create();
  await sync.requestSync();
  assert.equal(h.rules()[0].priority, 100);
  h.state.rules = [];
  assert.equal((await sync.requestSync()).success, true);
  assert.deepEqual(h.rules(), []);
  assert.deepEqual(h.updates[1], { removeRuleIds: [1], addRules: [] });
});

test('native priorities remain bounded and unique for a full unsafe-rule budget without mutating inputs', () => {
  const factory = createDnrRuleFactory(path => `https://extension.invalid/${path}`);
  const rules = Array.from({ length: 5000 }, (_, index) => factory(index + 1, 'yout/' + 'x'.repeat(index % 80), ''));
  const before = structuredClone(rules);
  const ranked = assignDnrRulePriorities(rules);
  const priorities = ranked.map(rule => rule.priority);
  assert.equal(new Set(priorities).size, 5000);
  assert.equal(Math.min(...priorities), 100);
  assert.equal(Math.max(...priorities), 5099);
  assert.ok(priorities.every(Number.isSafeInteger));
  assert.deepEqual(rules, before);
  assert.deepEqual(ranked.map(rule => rule.id), rules.map(rule => rule.id));
});

test('unrepresentable native priority sets fail before iterating a huge sparse array', () => {
  const impossible = [];
  impossible.length = 2_147_483_647 - 100 + 2;
  assert.throws(() => assignDnrRulePriorities(impossible), RangeError);
});
