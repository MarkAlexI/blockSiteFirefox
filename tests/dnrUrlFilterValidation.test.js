import test from 'node:test';
import assert from 'node:assert/strict';

import { RulesManager } from '../rules/rulesManager.js';
import { createDnrRuleFactory, InvalidDnrUrlFilterError } from '../rules/dnrRuleFactory.js';
import { createDnrSynchronizer, getDnrSyncFailureCode } from '../scripts/dnrSynchronizer.js';
import { urlSafetyScenarios } from '../e2e/url-safety-scenarios.mjs';

const manager = new RulesManager();
const factory = createDnrRuleFactory(path => `https://extension.invalid/${path}`);
const invalidPatterns = ['*', '*.example.com', 'https://*.example.com/private?key=secret', 'bad host/приватне'];

test('native legacy fixture is rejected before platform URL serialization can change its validity', async () => {
  let seed;
  const stop = new Error('seed captured');
  await assert.rejects(urlSafetyScenarios.find(scenario => scenario.id === '78').run({
    async seed(input) { seed = input; throw stop; }
  }), error => error === stop);
  const rule = seed.rules.find(rule => rule.id === 781);
  const OriginalURL = globalThis.URL;
  let urlCalls = 0;
  globalThis.URL = class {
    constructor() { urlCalls += 1; throw new Error('platform URL parser invoked'); }
  };
  try {
    assert.throws(() => factory(rule.id, rule.blockURL, rule.redirectURL, 'daily_limit'), InvalidDnrUrlFilterError);
    assert.equal(urlCalls, 0, 'the native fault fixture must not depend on platform URL parsing');
  } finally {
    globalThis.URL = OriginalURL;
  }
});

for (const pattern of invalidPatterns) {
  test(`blacklist rejects an invalid compiled DNR filter: ${pattern}`, () => {
    assert.deepEqual(manager.validateRule(pattern, '', null, 'social'), {
      isValid: false, errors: ['blockurl_invalid']
    });
    assert.throws(() => factory(1, pattern, ''), error => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'Invalid DNR URL filter.');
      return true;
    });
  });
}

test('DNR validation preserves fragments, serialized Unicode paths, and other accepted filter constructs', () => {
  for (const [pattern, expected] of [
    ['yout', '||yout'],
    ['youtube.com/short', '||youtube.com/short'],
    ['example.com/path%2Fpart', '||example.com/path%2Fpart'],
    ['https://приклад.укр/шлях', '||xn--80aikifvh.xn--j1amh/%D1%88%D0%BB%D1%8F%D1%85'],
    ['example.com/*/watch', '||example.com/*/watch'],
    ['example.com^', '||example.com^'],
    ['example.com/path|', '||example.com/path|']
  ]) {
    assert.deepEqual(manager.validateRule(pattern, '', null, 'social'), { isValid: true, errors: [] }, pattern);
    assert.equal(factory(1, pattern, '').condition.urlFilter, expected, pattern);
  }
});

test('Whitelist rejects unsupported host wildcards without duplicating existing input errors', () => {
  assert.deepEqual(manager.validateRule('*.example.com', '', null, '', true), { isValid: false, errors: ['blockurl_invalid'] });
  for (const pattern of ['', '   ']) {
    assert.deepEqual(manager.validateRule(pattern, '', null, 'social'), { isValid: false, errors: ['blockurl_empty'] });
  }
  assert.deepEqual(manager.validateRule('\uD800', '', null, 'social'), { isValid: false, errors: ['blockurl_invalid'] });
});

function storedRule(id, blockURL, extra = {}) {
  return { id, blockURL, redirectURL: '', category: 'social', isWhitelist: false,
    assignments: [{ listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null }], ...extra };
}

function legacyHarness({ createRule = factory, limits = {}, focusActive = false, active = rule => !rule.disabledByUser } = {}) {
  const rules = [storedRule(1, '*.private.example'), storedRule(2, 'yout')];
  const updates = [], reconciled = [], reported = [];
  let dynamic = [factory(99, 'removed.example', '')];
  const synchronizer = createDnrSynchronizer({
    getRules: async () => structuredClone(rules),
    getRuleListState: async () => ({ lists: [{ id: 'general', disabledCategories: [] }], activeRuleListId: 'general' }),
    getDailyUsage: async () => ({}),
    getFocusSessionState: async () => ({ focusActive }),
    getAccess: async () => ({ isPro: true }),
    isRuleActiveNow: active,
    createDnrRule: createRule,
    closeTabsMatchingRules: async urls => { reconciled.push([...urls]); },
    declarativeNetRequest: {
      ...limits,
      getDynamicRules: async () => structuredClone(dynamic),
      async updateDynamicRules(update) {
        // API model: invalid filters reject the complete atomic update.
        for (const rule of update.addRules) {
          assert.match(rule.condition.urlFilter, /^[\x00-\x7F]+$/);
          assert.equal(rule.condition.urlFilter.startsWith('||*'), false);
        }
        updates.push(structuredClone(update));
        const removed = new Set(update.removeRuleIds);
        dynamic = dynamic.filter(rule => !removed.has(rule.id)).concat(structuredClone(update.addRules));
      }
    },
    logger: { log() {}, info() {}, warn() {}, error() {} },
    onSyncResult: async result => { reported.push(result); }
  });
  return { rules, updates, reconciled, reported, synchronizer, dynamic: () => structuredClone(dynamic) };
}

for (const focusActive of [false, true]) {
  test(`legacy invalid filters cannot poison valid DNR changes or navigation, focus=${focusActive}`, async () => {
    const h = legacyHarness({ focusActive });
    const before = structuredClone(h.rules);
    const result = await h.synchronizer.requestSync();
    assert.equal(result.success, false);
    assert.equal(result.changed, true);
    assert.equal(result.removed, 1);
    assert.equal(result.added, 1);
    assert.equal(result.invalidRuleCount, 1);
    assert.equal(result.errorStage, 'build_rules');
    assert.equal(getDnrSyncFailureCode(result), 'sync_rule_build_failed');
    assert.deepEqual(h.reported, [result]);
    assert.deepEqual(h.dynamic().map(rule => rule.id), [2]);
    assert.deepEqual(h.reconciled, [['yout']]);
    assert.deepEqual(h.rules, before);
    assert.equal(JSON.stringify(result).includes('private.example'), false);
    assert.ok(await h.synchronizer.resolveNavigation('https://youtube.com/watch'));
    assert.equal(await h.synchronizer.resolveNavigation('https://private.example/'), null);
    const state = await h.synchronizer.inspectState();
    assert.equal(state.expectedCount, 1);
    assert.equal(state.invalidRuleCount, 1);
    assert.equal(state.inSync, false);

    const retry = await h.synchronizer.requestSync();
    assert.equal(retry.success, false);
    assert.equal(retry.changed, false);
    assert.equal(h.updates.length, 1);

    h.rules[0].blockURL = 'repaired.example';
    const repaired = await h.synchronizer.requestSync();
    assert.equal(repaired.success, true);
    assert.deepEqual(h.dynamic().map(rule => rule.id).sort(), [1, 2]);
    assert.equal((await h.synchronizer.inspectState()).inSync, true);
  });
}

test('removing the last valid rule still removes its browser blocker beside an invalid legacy row', async () => {
  const h = legacyHarness();
  await h.synchronizer.requestSync();
  h.rules.splice(1, 1);
  const result = await h.synchronizer.requestSync();
  assert.equal(result.success, false);
  assert.equal(result.removed, 1);
  assert.deepEqual(h.dynamic(), []);
  assert.deepEqual(h.updates.at(-1), { removeRuleIds: [2], addRules: [] });
});

test('disabled invalid legacy rows do not prevent normal synchronization or capacity validation', async () => {
  const h = legacyHarness({ limits: { MAX_NUMBER_OF_DYNAMIC_RULES: 1 } });
  h.rules[0].disabledByUser = true;
  assert.equal((await h.synchronizer.requestSync()).success, true);
  h.rules[0].disabledByUser = false;
  const capacity = await h.synchronizer.validateRuleCapacity(h.rules);
  assert.equal(capacity.withinCapacity, true);
  assert.equal((await h.synchronizer.requestSync()).invalidRuleCount, 1);
});

test('unexpected rule-construction failures still stop the atomic update', async () => {
  const h = legacyHarness({ createRule() { throw new TypeError('unexpected builder failure'); } });
  const before = h.dynamic();
  const result = await h.synchronizer.requestSync();
  assert.equal(result.success, false);
  assert.equal(result.error, 'unexpected builder failure');
  assert.equal(result.errorStage, 'build_rules');
  assert.equal(result.invalidRuleCount, undefined);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.dynamic(), before);
});
