import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDnrDiff,
  createDnrSynchronizer,
  getDnrSignature
} from '../scripts/dnrSynchronizer.js';
import { isRuleActiveNow } from '../rules/ruleActivation.js';

function makeDnrRule({
  id = 1,
  urlFilter = '||example.com',
  redirectUrl = 'blocked.html',
  priority = 1,
  resourceTypes = ['main_frame']
} = {}) {
  return {
    id,
    priority,
    action: {
      type: 'redirect',
      redirect: { url: redirectUrl }
    },
    condition: {
      urlFilter,
      resourceTypes
    }
  };
}

function makeStoredRule({
  id = 1,
  blockURL = 'example.com',
  redirectURL = '',
  active = true,
  isWhitelist = false,
  category = 'social',
  assignments = [{ listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null }]
} = {}) {
  return {
    id,
    blockURL,
    redirectURL,
    category,
    disabledByUser: active === false,
    assignments,
    isWhitelist
  };
}

function createHarness({
  storedRules = [makeStoredRule()],
  currentDnrRules = [],
  createRule,
  getRules,
  onSyncResult,
  ruleLists = [{ id: 'general', name: 'General', disabledCategories: [] }],
  activeRuleListId = 'general',
  activationEvaluator = null,
  dailyUsage = {}
} = {}) {
  const updates = [];
  const closedUrlBatches = [];
  const logs = [];
  let dynamicRules = structuredClone(currentDnrRules);

  const getStoredRules = getRules ??
    (async () => structuredClone(storedRules));
  const isStoredRuleActive = activationEvaluator || isRuleActiveNow;
  const buildDnrRule = createRule ??
    (async (id, blockURL, redirectURL) => makeDnrRule({
      id,
      urlFilter: `||${blockURL}`,
      redirectUrl: redirectURL || 'blocked.html'
    }));

  const declarativeNetRequest = {
    async getDynamicRules() {
      return structuredClone(dynamicRules);
    },
    async updateDynamicRules(update) {
      updates.push(structuredClone(update));
      const removed = new Set(update.removeRuleIds ?? []);
      dynamicRules = dynamicRules.filter(rule => !removed.has(rule.id));
      dynamicRules.push(...structuredClone(update.addRules ?? []));
    }
  };

  const logger = {
    log: (...args) => logs.push(['log', ...args]),
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args])
  };

  const synchronizer = createDnrSynchronizer({
    getRules: getStoredRules,
    getRuleListState: async () => ({
      lists: structuredClone(ruleLists),
      activeRuleListId
    }),
    getDailyUsage: async () => structuredClone(dailyUsage),
    getFocusSessionState: async () => ({ focusActive: false }),
    isRuleActiveNow: isStoredRuleActive,
    createDnrRule: buildDnrRule,
    closeTabsMatchingRules: async urls => {
      closedUrlBatches.push([...urls]);
    },
    declarativeNetRequest,
    logger,
    onSyncResult
  });

  return {
    synchronizer,
    updates,
    closedUrlBatches,
    logs,
    getDynamicRules: () => structuredClone(dynamicRules)
  };
}

test('DNR signature ignores resourceTypes order', () => {
  const first = makeDnrRule({
    resourceTypes: ['sub_frame', 'main_frame']
  });
  const second = makeDnrRule({
    resourceTypes: ['main_frame', 'sub_frame']
  });

  assert.equal(getDnrSignature(first), getDnrSignature(second));
});

test('identical DNR sets produce an empty diff', () => {
  const rule = makeDnrRule();

  assert.deepEqual(buildDnrDiff([rule], [structuredClone(rule)]), {
    removeRuleIds: [],
    addRules: []
  });
});

test('new and removed rules are returned selectively', () => {
  const current = makeDnrRule({ id: 1 });
  const expected = makeDnrRule({ id: 2 });

  assert.deepEqual(buildDnrDiff([current], [expected]), {
    removeRuleIds: [1],
    addRules: [expected]
  });
});

test('an edited rule with the same ID is replaced atomically', () => {
  const current = makeDnrRule({ id: 7, urlFilter: '||old.example' });
  const expected = makeDnrRule({ id: 7, urlFilter: '||new.example' });

  assert.deepEqual(buildDnrDiff([current], [expected]), {
    removeRuleIds: [7],
    addRules: [expected]
  });
});

test('redirect and priority changes are detected', () => {
  const current = makeDnrRule({ id: 3 });
  const expected = makeDnrRule({
    id: 3,
    redirectUrl: 'https://example.org',
    priority: 2
  });

  const diff = buildDnrDiff([current], [expected]);
  assert.deepEqual(diff.removeRuleIds, [3]);
  assert.deepEqual(diff.addRules, [expected]);
});

test('synchronization skips the DNR API when rules are already current', async () => {
  const current = makeDnrRule();
  const harness = createHarness({ currentDnrRules: [current] });

  await harness.synchronizer.requestSync();

  assert.equal(harness.updates.length, 0);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('synchronization applies one atomic remove/add for an edited stable ID', async () => {
  const current = makeDnrRule({ id: 1, urlFilter: '||old.example' });
  const harness = createHarness({
    storedRules: [makeStoredRule({ id: 1, blockURL: 'new.example' })],
    currentDnrRules: [current]
  });

  await harness.synchronizer.requestSync();

  assert.equal(harness.updates.length, 1);
  assert.deepEqual(harness.updates[0].removeRuleIds, [1]);
  assert.equal(harness.updates[0].addRules[0].id, 1);
  assert.equal(
    harness.updates[0].addRules[0].condition.urlFilter,
    '||new.example'
  );
});

test('overlapping sync requests are serialized and rerun with fresh state', async () => {
  let getRulesCalls = 0;
  let releaseFirstRead;
  let firstReadStarted;
  const firstReadStartedPromise = new Promise(resolve => {
    firstReadStarted = resolve;
  });
  const firstReadGate = new Promise(resolve => {
    releaseFirstRead = resolve;
  });

  const getRules = async () => {
    getRulesCalls += 1;

    if (getRulesCalls === 1) {
      firstReadStarted();
      await firstReadGate;
      return [makeStoredRule({ blockURL: 'first.example' })];
    }

    return [makeStoredRule({ blockURL: 'second.example' })];
  };

  const harness = createHarness({ getRules });
  const firstSync = harness.synchronizer.requestSync();
  await firstReadStartedPromise;
  const secondSync = harness.synchronizer.requestSync();

  assert.strictEqual(firstSync, secondSync);

  releaseFirstRead();
  await Promise.all([firstSync, secondSync]);

  assert.equal(getRulesCalls, 2);
  assert.equal(harness.updates.length, 2);
  assert.equal(
    harness.getDynamicRules()[0].condition.urlFilter,
    '||second.example'
  );
});

test('integrity validation compares against active rules and repairs drift', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'active.example' }),
      makeStoredRule({ id: 2, blockURL: 'inactive.example', active: false }),
      makeStoredRule({ id: 3, blockURL: 'allow.example', isWhitelist: true })
    ],
    currentDnrRules: []
  });

  const isInSync = await harness.synchronizer.validateIntegrity();

  assert.equal(isInSync, false);
  assert.equal(harness.updates.length, 1);
  assert.deepEqual(
    harness.updates[0].addRules.map(rule => rule.id),
    [1]
  );
});

test('clearing all active rules passes every ID with an explicit empty addRules array', async () => {
  const harness = createHarness({
    storedRules: [],
    currentDnrRules: [
      makeDnrRule({ id: 4, urlFilter: '||one.example' }),
      makeDnrRule({ id: 9, urlFilter: '||two.example' })
    ]
  });

  await harness.synchronizer.requestSync();

  assert.deepEqual(harness.updates, [{
    removeRuleIds: [4, 9],
    addRules: []
  }]);
  assert.deepEqual(harness.getDynamicRules(), []);
});

test('DNR inspection reports drift without modifying browser rules', async () => {
  const harness = createHarness({
    storedRules: [makeStoredRule({ id: 5, blockURL: 'expected.example' })],
    currentDnrRules: [makeDnrRule({ id: 9, urlFilter: '||unexpected.example' })]
  });

  const state = await harness.synchronizer.inspectState();

  assert.deepEqual(state, {
    activeRuleCount: 1,
    expectedCount: 1,
    currentCount: 1,
    inSync: false,
    removeCount: 1,
    addCount: 1
  });
  assert.equal(harness.updates.length, 0);
  assert.equal(harness.closedUrlBatches.length, 0);
});

test('DNR synchronization reports its final structured result', async () => {
  const results = [];
  const harness = createHarness({
    currentDnrRules: [],
    onSyncResult: async result => results.push(structuredClone(result))
  });

  const result = await harness.synchronizer.requestSync();

  assert.deepEqual(results, [result]);
  assert.deepEqual(result, {
    success: true,
    changed: true,
    removed: 0,
    added: 1
  });
});


test('only assignments from the active Rule List profile participate in DNR', async () => {
  const storedRule = makeStoredRule({
    id: 1,
    blockURL: 'work.example',
    assignments: [{ listId: 'work', blockingMode: 'always', schedule: null, dailyLimit: null }]
  });

  const generalHarness = createHarness({
    storedRules: [storedRule],
    currentDnrRules: [makeDnrRule({ id: 1, urlFilter: '||work.example' })],
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'work', name: 'Work', disabledCategories: [] }
    ],
    activeRuleListId: 'general'
  });
  await generalHarness.synchronizer.requestSync();
  assert.deepEqual(generalHarness.updates[0], { removeRuleIds: [1], addRules: [] });
  assert.deepEqual(generalHarness.closedUrlBatches, []);

  const workHarness = createHarness({
    storedRules: [storedRule],
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'work', name: 'Work', disabledCategories: [] }
    ],
    activeRuleListId: 'work'
  });
  await workHarness.synchronizer.requestSync();
  assert.equal(workHarness.getDynamicRules().length, 1);
});

test('category blocking is scoped to the active profile', async () => {
  const storedRule = makeStoredRule({ blockURL: 'social.example', category: 'social' });
  const mutedHarness = createHarness({
    storedRules: [storedRule],
    ruleLists: [{ id: 'general', name: 'General', disabledCategories: ['social'] }],
    activeRuleListId: 'general'
  });
  await mutedHarness.synchronizer.requestSync();
  assert.equal(mutedHarness.getDynamicRules().length, 0);
});

test('DNR uses the active profile schedule and still emits only one rule for the target', async () => {
  const tuesdayAt1030 = new Date(2026, 7, 4, 10, 30);
  const storedRule = makeStoredRule({
    id: 11,
    blockURL: 'youtube.com',
    assignments: [
      {
        listId: 'work',
        blockingMode: 'schedule',
        schedule: { version: 2, periods: [{ days: [2], startTime: '09:00', endTime: '10:00' }] },
        dailyLimit: null
      },
      {
        listId: 'study',
        blockingMode: 'schedule',
        schedule: { version: 2, periods: [{ days: [2], startTime: '10:00', endTime: '11:00' }] },
        dailyLimit: null
      }
    ]
  });
  const evaluateAtFixedTime = (rule, disabledCategories, focusActive, _now, activeListId, usage) =>
    isRuleActiveNow(rule, disabledCategories, focusActive, tuesdayAt1030, activeListId, usage);

  const workHarness = createHarness({
    storedRules: [storedRule],
    activationEvaluator: evaluateAtFixedTime,
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'work', name: 'Work', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    activeRuleListId: 'work'
  });
  await workHarness.synchronizer.requestSync();
  assert.equal(workHarness.getDynamicRules().length, 0);

  const studyHarness = createHarness({
    storedRules: [storedRule],
    activationEvaluator: evaluateAtFixedTime,
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'work', name: 'Work', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    activeRuleListId: 'study'
  });
  await studyHarness.synchronizer.requestSync();
  assert.equal(studyHarness.getDynamicRules().length, 1);
  assert.equal(studyHarness.getDynamicRules()[0].id, 11);
});
