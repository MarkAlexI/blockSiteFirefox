import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDnrDiff,
  createDnrSynchronizer,
  getDnrRuleCapacity,
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
  dailyUsage = {},
  focusActive = false,
  access = { isPro: true, isLegacyUser: false },
  dnrLimits = {},
  updateError = null
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
    ...dnrLimits,
    async getDynamicRules() {
      return structuredClone(dynamicRules);
    },
    async updateDynamicRules(update) {
      if (updateError) throw updateError;
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
    getFocusSessionState: async () => ({ focusActive }),
    getAccess: async () => structuredClone(access),
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

function createTimedScheduleHarness({
  days = [1],
  startTime = '22:00',
  endTime = '06:00',
  initialNow = new Date(2026, 7, 3, 21, 59),
  listId = 'general',
  activeRuleListId = listId,
  currentDnrRules = [],
  disabledByUser = false,
  disabledCategories = []
} = {}) {
  let now = initialNow;
  const lists = [{ id: 'general', name: 'General', disabledCategories: [] }];
  if (listId !== 'general') {
    lists.push({ id: listId, name: 'Study', disabledCategories });
  } else {
    lists[0].disabledCategories = disabledCategories;
  }
  const harness = createHarness({
    storedRules: [makeStoredRule({
      id: 91,
      blockURL: 'night.example',
      assignments: [{
        listId,
        disabledByUser,
        blockingMode: 'schedule',
        schedule: { version: 2, periods: [{ days, startTime, endTime }] },
        dailyLimit: null
      }]
    })],
    currentDnrRules,
    ruleLists: lists,
    activeRuleListId,
    activationEvaluator: (rule, categories, focusActive, _ignoredNow, activeListId, usage) =>
      isRuleActiveNow(rule, categories, focusActive, now, activeListId, usage)
  });

  return {
    ...harness,
    setNow(value) { now = value; }
  };
}

test('DNR capacity reads modern, legacy, and optional unsafe browser limits safely', () => {
  assert.deepEqual(getDnrRuleCapacity({}), {
    maxDynamicRules: null,
    maxUnsafeDynamicRules: null
  });
  assert.deepEqual(getDnrRuleCapacity({
    MAX_NUMBER_OF_DYNAMIC_RULES: 20,
    MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 3
  }), {
    maxDynamicRules: 20,
    maxUnsafeDynamicRules: 3
  });
  assert.deepEqual(getDnrRuleCapacity({
    MAX_NUMBER_OF_DYNAMIC_RULES: 0,
    MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 7,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 'invalid'
  }), {
    maxDynamicRules: 7,
    maxUnsafeDynamicRules: null
  });
});

test('browsers without exposed DNR limits skip candidate reads and rule generation', async () => {
  let generatedRules = 0;
  const harness = createHarness({
    createRule: async (...args) => {
      generatedRules += 1;
      return makeDnrRule({ id: args[0] });
    }
  });

  const result = await harness.synchronizer.validateRuleCapacity([
    makeStoredRule({ id: 10, blockURL: 'candidate.example' })
  ]);

  assert.deepEqual(result, {
    maxDynamicRules: null,
    maxUnsafeDynamicRules: null,
    withinCapacity: true
  });
  assert.equal(generatedRules, 0);
});

test('prospective Pro Focus capacity includes rules from currently inactive profiles', async () => {
  const rules = [
    makeStoredRule({ id: 1, blockURL: 'general.example' }),
    makeStoredRule({
      id: 2,
      blockURL: 'study.example',
      assignments: [{ listId: 'study', blockingMode: 'always' }]
    })
  ];
  const harness = createHarness({
    storedRules: rules,
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 }
  });

  const normal = await harness.synchronizer.validateRuleCapacity(rules);
  const focus = await harness.synchronizer.validateRuleCapacity(
    null,
    null,
    { focusActive: true },
    { isPro: true, isLegacyUser: false }
  );

  assert.equal(normal.expectedUnsafeCount, 1);
  assert.equal(normal.withinCapacity, true);
  assert.equal(focus.expectedUnsafeCount, 2);
  assert.equal(focus.withinCapacity, false);
  assert.equal(focus.limitType, 'unsafe_dynamic');
  assert.deepEqual(harness.updates, []);
});

test('prospective Free Focus ignores inactive paid profiles when checking DNR capacity', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'general.example' }),
      makeStoredRule({
        id: 2,
        blockURL: 'study.example',
        assignments: [{ listId: 'study', blockingMode: 'always' }]
      })
    ],
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    activeRuleListId: 'study',
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 }
  });

  const result = await harness.synchronizer.validateRuleCapacity(
    null,
    null,
    { focusActive: true },
    { isPro: false, isLegacyUser: false }
  );

  assert.equal(result.expectedUnsafeCount, 1);
  assert.equal(result.withinCapacity, true);
});

test('prospective legacy Focus evaluates the same global browser budget as Pro', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'general.example' }),
      makeStoredRule({
        id: 2,
        blockURL: 'study.example',
        assignments: [{ listId: 'study', blockingMode: 'always' }]
      })
    ],
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    dnrLimits: { MAX_NUMBER_OF_DYNAMIC_RULES: 1 }
  });

  const result = await harness.synchronizer.validateRuleCapacity(
    null,
    null,
    { focusActive: true },
    { isPro: false, isLegacyUser: true }
  );

  assert.equal(result.expectedCount, 2);
  assert.equal(result.withinCapacity, false);
  assert.equal(result.limitType, 'dynamic');
});

test('prospective Focus validation remains a no-op when Firefox exposes no rule constants', async () => {
  const harness = createHarness({
    getRules: async () => { throw new Error('candidate rules must not be loaded'); }
  });

  const result = await harness.synchronizer.validateRuleCapacity(
    null,
    null,
    { focusActive: true },
    { isPro: true }
  );

  assert.equal(result.withinCapacity, true);
  assert.equal(result.maxDynamicRules, null);
  assert.equal(result.maxUnsafeDynamicRules, null);
});

test('unsafe redirect capacity rejects oversized DNR updates without altering current rules', async () => {
  const current = makeDnrRule({ id: 1, urlFilter: '||first.example' });
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'first.example' }),
      makeStoredRule({ id: 2, blockURL: 'second.example' })
    ],
    currentDnrRules: [current],
    dnrLimits: {
      MAX_NUMBER_OF_DYNAMIC_RULES: 10,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1
    }
  });

  const result = await harness.synchronizer.requestSync();

  assert.equal(result.success, false);
  assert.equal(result.code, 'dnr_rule_limit_reached');
  assert.equal(result.errorName, 'DnrCapacityError');
  assert.equal(result.capacity.limitType, 'unsafe_dynamic');
  assert.equal(result.capacity.expectedUnsafeCount, 2);
  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.getDynamicRules(), [current]);
  assert.deepEqual(harness.closedUrlBatches, []);
});

test('overall dynamic capacity is enforced when no separate unsafe limit exists', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'first.example' }),
      makeStoredRule({ id: 2, blockURL: 'second.example' })
    ],
    dnrLimits: { MAX_NUMBER_OF_DYNAMIC_RULES: 1 }
  });

  const result = await harness.synchronizer.requestSync();

  assert.equal(result.success, false);
  assert.equal(result.capacity.limitType, 'dynamic');
  assert.equal(result.capacity.maxDynamicRules, 1);
  assert.equal(harness.updates.length, 0);
});

test('safe DNR actions do not consume the separate unsafe redirect budget', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'safe.example' }),
      makeStoredRule({ id: 2, blockURL: 'redirect.example' })
    ],
    createRule: async id => {
      const rule = makeDnrRule({ id });
      if (id === 1) rule.action = { type: 'block' };
      return rule;
    },
    dnrLimits: {
      MAX_NUMBER_OF_DYNAMIC_RULES: 2,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1
    }
  });

  const result = await harness.synchronizer.requestSync();

  assert.equal(result.success, true);
  assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [1, 2]);
  const state = await harness.synchronizer.inspectState();
  assert.equal(state.expectedUnsafeCount, 1);
  assert.equal(state.withinCapacity, true);
});

test('candidate capacity counts only the selected Rule List and ignores inactive profiles', async () => {
  const lists = [
    { id: 'general', name: 'General', disabledCategories: [] },
    { id: 'study', name: 'Study', disabledCategories: [] }
  ];
  const rules = [
    makeStoredRule({ id: 1, blockURL: 'general.example' }),
    ...Array.from({ length: 3 }, (_, index) => makeStoredRule({
      id: index + 2,
      blockURL: `study-${index}.example`,
      assignments: [{
        listId: 'study',
        blockingMode: 'always',
        schedule: null,
        dailyLimit: null
      }]
    }))
  ];
  const harness = createHarness({
    storedRules: rules,
    ruleLists: lists,
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 }
  });

  const general = await harness.synchronizer.validateRuleCapacity(rules, {
    lists,
    activeRuleListId: 'general'
  });
  const study = await harness.synchronizer.validateRuleCapacity(rules, {
    lists,
    activeRuleListId: 'study'
  });

  assert.equal(general.expectedCount, 1);
  assert.equal(general.withinCapacity, true);
  assert.equal(study.expectedCount, 3);
  assert.equal(study.withinCapacity, false);
});

test('disabled rules and disabled categories do not consume active DNR capacity', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'blocked.example', category: 'social' }),
      makeStoredRule({ id: 2, blockURL: 'disabled.example', active: false }),
      makeStoredRule({ id: 3, blockURL: 'hidden.example', category: 'news' })
    ],
    ruleLists: [{ id: 'general', name: 'General', disabledCategories: ['news'] }],
    dnrLimits: { MAX_NUMBER_OF_DYNAMIC_RULES: 1 }
  });

  const result = await harness.synchronizer.requestSync();

  assert.equal(result.success, true);
  assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [1]);
});

test('removal-only DNR repairs remain available even above a changed browser limit', async () => {
  const current = [
    makeDnrRule({ id: 1, urlFilter: '||one.example' }),
    makeDnrRule({ id: 2, urlFilter: '||two.example' }),
    makeDnrRule({ id: 3, urlFilter: '||three.example' })
  ];
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'one.example' }),
      makeStoredRule({ id: 2, blockURL: 'two.example' })
    ],
    currentDnrRules: current,
    dnrLimits: { MAX_NUMBER_OF_DYNAMIC_RULES: 1 }
  });

  const result = await harness.synchronizer.requestSync();

  assert.equal(result.success, true);
  assert.deepEqual(harness.updates[0].removeRuleIds, [3]);
  assert.deepEqual(harness.updates[0].addRules, []);
});

test('browser DNR quota exceptions receive a stable actionable error code', async () => {
  const harness = createHarness({
    updateError: new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES')
  });

  const result = await harness.synchronizer.requestSync();

  assert.equal(result.success, false);
  assert.equal(result.code, 'dnr_rule_limit_reached');
  assert.equal(result.errorName, 'Error');
});

test('DNR inspection reports both actual redirect usage and browser capacity', async () => {
  const harness = createHarness({
    dnrLimits: {
      MAX_NUMBER_OF_DYNAMIC_RULES: 8,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 2
    }
  });

  const state = await harness.synchronizer.inspectState();

  assert.equal(state.expectedCount, 1);
  assert.equal(state.expectedUnsafeCount, 1);
  assert.equal(state.maxDynamicRules, 8);
  assert.equal(state.maxUnsafeDynamicRules, 2);
  assert.equal(state.withinCapacity, true);
});

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

test('passive watchdog synchronization skips existing tabs when browser rules are current', async () => {
  const harness = createHarness({ currentDnrRules: [makeDnrRule()] });

  const first = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  const second = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.equal(first.success, true);
  assert.equal(first.changed, false);
  assert.equal(second.changed, false);
  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.closedUrlBatches, []);
});

test('an explicit synchronization still reconciles stable tabs after a passive watchdog', async () => {
  const harness = createHarness({ currentDnrRules: [makeDnrRule()] });

  await harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  await harness.synchronizer.requestSync();

  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('a passive watchdog closes existing tabs when a blocking rule becomes active', async () => {
  const harness = createHarness();

  const result = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.equal(result.changed, true);
  assert.equal(result.added, 1);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('a passive watchdog detects scheduled activation before skipping stable later scans', async () => {
  let active = false;
  const harness = createHarness({
    activationEvaluator: () => active
  });

  const inactive = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  assert.equal(inactive.changed, false);
  assert.deepEqual(harness.closedUrlBatches, []);

  active = true;
  const activated = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  const stable = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.equal(activated.changed, true);
  assert.equal(stable.changed, false);
  assert.equal(harness.updates.length, 1);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('a passive watchdog repairs edited browser rules and reconciles the active target', async () => {
  const harness = createHarness({
    storedRules: [makeStoredRule({ id: 4, blockURL: 'current.example' })],
    currentDnrRules: [makeDnrRule({ id: 4, urlFilter: '||obsolete.example' })]
  });

  const result = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.equal(result.changed, true);
  assert.deepEqual(harness.updates[0].removeRuleIds, [4]);
  assert.equal(harness.updates[0].addRules[0].condition.urlFilter, '||current.example');
  assert.deepEqual(harness.closedUrlBatches, [['current.example']]);
});

test('a passive watchdog reconciles remaining active tabs after removing stale browser rules', async () => {
  const harness = createHarness({
    storedRules: [makeStoredRule({ id: 1, blockURL: 'protected.example' })],
    currentDnrRules: [
      makeDnrRule({ id: 1, urlFilter: '||protected.example' }),
      makeDnrRule({ id: 9, urlFilter: '||stale.example' })
    ]
  });

  const result = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.equal(result.changed, true);
  assert.deepEqual(harness.updates[0], { removeRuleIds: [9], addRules: [] });
  assert.deepEqual(harness.closedUrlBatches, [['protected.example']]);
});

test('passive removal of every active rule never queries or closes existing tabs', async () => {
  const harness = createHarness({
    storedRules: [],
    currentDnrRules: [makeDnrRule()]
  });

  const result = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.equal(result.changed, true);
  assert.deepEqual(harness.getDynamicRules(), []);
  assert.deepEqual(harness.closedUrlBatches, []);
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
  assert.deepEqual(harness.closedUrlBatches, [['second.example']]);
});

test('an explicit request superseding a passive watchdog still reconciles unchanged tabs', async () => {
  let reads = 0;
  let firstReadStarted;
  let releaseFirstRead;
  const firstReadReady = new Promise(resolve => { firstReadStarted = resolve; });
  const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve; });
  const harness = createHarness({
    currentDnrRules: [makeDnrRule()],
    getRules: async () => {
      if (++reads === 1) {
        firstReadStarted();
        await firstReadGate;
      }
      return [makeStoredRule()];
    }
  });

  const passive = harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  await firstReadReady;
  const explicit = harness.synchronizer.requestSync();
  releaseFirstRead();
  await Promise.all([passive, explicit]);

  assert.equal(reads, 2);
  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('a passive watchdog cannot downgrade an overlapping explicit tab reconciliation', async () => {
  let reads = 0;
  let firstReadStarted;
  let releaseFirstRead;
  const firstReadReady = new Promise(resolve => { firstReadStarted = resolve; });
  const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve; });
  const harness = createHarness({
    currentDnrRules: [makeDnrRule()],
    getRules: async () => {
      if (++reads === 1) {
        firstReadStarted();
        await firstReadGate;
      }
      return [makeStoredRule()];
    }
  });

  const explicit = harness.synchronizer.requestSync();
  await firstReadReady;
  const passive = harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  releaseFirstRead();
  await Promise.all([explicit, passive]);

  assert.equal(reads, 2);
  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('superseded passive DNR changes carry required tab cleanup into the latest snapshot', async () => {
  let reads = 0;
  let firstReadStarted;
  let releaseFirstRead;
  const firstReadReady = new Promise(resolve => { firstReadStarted = resolve; });
  const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve; });
  const harness = createHarness({
    getRules: async () => {
      if (++reads === 1) {
        firstReadStarted();
        await firstReadGate;
      }
      return [makeStoredRule()];
    }
  });

  const first = harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  await firstReadReady;
  const second = harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  releaseFirstRead();
  await Promise.all([first, second]);

  assert.equal(reads, 2);
  assert.equal(harness.updates.length, 1);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('superseded passive cleanup never closes tabs for a target removed by a newer snapshot', async () => {
  let reads = 0;
  let firstReadStarted;
  let releaseFirstRead;
  const firstReadReady = new Promise(resolve => { firstReadStarted = resolve; });
  const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve; });
  const harness = createHarness({
    getRules: async () => {
      if (++reads === 1) {
        firstReadStarted();
        await firstReadGate;
        return [makeStoredRule({ blockURL: 'removed.example' })];
      }
      return [];
    }
  });

  const stale = harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  await firstReadReady;
  const current = harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  releaseFirstRead();
  await Promise.all([stale, current]);

  assert.deepEqual(harness.getDynamicRules(), []);
  assert.deepEqual(harness.closedUrlBatches, []);
});

test('a late explicit request during diagnostics preserves its tab reconciliation intent', async () => {
  let diagnosticsStarted;
  let releaseDiagnostics;
  const diagnosticsReady = new Promise(resolve => { diagnosticsStarted = resolve; });
  const diagnosticsGate = new Promise(resolve => { releaseDiagnostics = resolve; });
  let reports = 0;
  const harness = createHarness({
    currentDnrRules: [makeDnrRule()],
    onSyncResult: async () => {
      if (++reports === 1) {
        diagnosticsStarted();
        await diagnosticsGate;
      }
    }
  });

  const passive = harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  await diagnosticsReady;
  const explicit = harness.synchronizer.requestSync();
  releaseDiagnostics();
  await Promise.all([passive, explicit]);

  assert.equal(reports, 2);
  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('a superseded DNR snapshot never closes tabs for a rule that was removed', async () => {
  let readCount = 0;
  let firstReadStarted;
  let releaseFirstRead;
  const firstReadReady = new Promise(resolve => { firstReadStarted = resolve; });
  const firstReadGate = new Promise(resolve => { releaseFirstRead = resolve; });
  const harness = createHarness({
    getRules: async () => {
      readCount += 1;
      if (readCount === 1) {
        firstReadStarted();
        await firstReadGate;
        return [makeStoredRule({ blockURL: 'restored.example' })];
      }
      return [];
    }
  });

  const staleSync = harness.synchronizer.requestSync();
  await firstReadReady;
  const currentSync = harness.synchronizer.requestSync();
  releaseFirstRead();
  await Promise.all([staleSync, currentSync]);

  assert.deepEqual(harness.getDynamicRules(), []);
  assert.deepEqual(harness.closedUrlBatches, []);
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
    expectedUnsafeCount: 1,
    currentCount: 1,
    inSync: false,
    removeCount: 1,
    addCount: 1,
    maxDynamicRules: null,
    maxUnsafeDynamicRules: null,
    withinCapacity: true
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


test('Focus Session emits one deterministic DNR rule when profiles use different targets for the same block URL', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({
        id: 21,
        blockURL: 'yout',
        redirectURL: '',
        assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }]
      }),
      makeStoredRule({
        id: 22,
        blockURL: 'yout',
        redirectURL: 'https://example.com/focus',
        assignments: [{ listId: 'list-1', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }]
      })
    ],
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Ext', disabledCategories: [] }
    ],
    activeRuleListId: 'list-1',
    focusActive: true
  });

  await harness.synchronizer.requestSync();
  const rules = harness.getDynamicRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 22);
  assert.equal(rules[0].action.redirect.url, 'https://example.com/focus');
});

test('Free Focus activates only General assignments even when a custom list remains selected', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({
        id: 41,
        blockURL: 'general.example',
        assignments: [{
          listId: 'general', disabledByUser: true, blockingMode: 'always', schedule: null, dailyLimit: null
        }]
      }),
      makeStoredRule({
        id: 42,
        blockURL: 'study.example',
        assignments: [{ listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null }]
      }),
      makeStoredRule({
        id: 43,
        blockURL: 'shared.example',
        assignments: [
          { listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null },
          { listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null }
        ]
      }),
      makeStoredRule({ id: 44, blockURL: 'allowed.example', isWhitelist: true })
    ],
    currentDnrRules: [makeDnrRule({ id: 42, urlFilter: '||study.example' })],
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: ['social'] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    activeRuleListId: 'list-1',
    focusActive: true,
    access: { isPro: false, isLegacyUser: false }
  });

  await harness.synchronizer.requestSync();

  assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [41, 43]);
  assert.deepEqual(harness.updates[0].removeRuleIds, [42]);
  assert.deepEqual(harness.closedUrlBatches, [['general.example', 'shared.example']]);
});

test('Free Focus removes preserved custom-only browser rules when General is empty', async () => {
  const harness = createHarness({
    storedRules: [makeStoredRule({
      id: 51,
      blockURL: 'study.example',
      assignments: [{ listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null }]
    })],
    currentDnrRules: [makeDnrRule({ id: 51, urlFilter: '||study.example' })],
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    activeRuleListId: 'list-1',
    focusActive: true,
    access: { isPro: false, isLegacyUser: false }
  });

  await harness.synchronizer.requestSync();

  assert.deepEqual(harness.getDynamicRules(), []);
  assert.deepEqual(harness.updates, [{ removeRuleIds: [51], addRules: [] }]);
  assert.deepEqual(harness.closedUrlBatches, []);
});

test('Pro and legacy Focus preserve global activation across Rule Lists', async () => {
  for (const access of [
    { isPro: true, isLegacyUser: false },
    { isPro: false, isLegacyUser: true }
  ]) {
    const harness = createHarness({
      storedRules: [
        makeStoredRule({ id: 61, blockURL: 'general.example' }),
        makeStoredRule({
          id: 62,
          blockURL: 'study.example',
          assignments: [{ listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null }]
        })
      ],
      ruleLists: [
        { id: 'general', name: 'General', disabledCategories: [] },
        { id: 'list-1', name: 'Study', disabledCategories: [] }
      ],
      focusActive: true,
      access
    });

    await harness.synchronizer.requestSync();
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [61, 62]);
  }
});

test('Free Focus always chooses the General variant when a custom target duplicates it', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({
        id: 71,
        blockURL: 'shared.example',
        redirectURL: 'https://study.example/redirect',
        assignments: [{ listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null }]
      }),
      makeStoredRule({ id: 72, blockURL: 'shared.example' })
    ],
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    activeRuleListId: 'list-1',
    focusActive: true,
    access: { isPro: false, isLegacyUser: false }
  });

  await harness.synchronizer.requestSync();

  assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [72]);
  assert.equal(harness.getDynamicRules()[0].action.redirect.url, 'blocked.html');
});

test('overnight DNR rules activate at the start, survive midnight, and expire at the exclusive end', async () => {
  const harness = createTimedScheduleHarness();
  const sync = () => harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  await sync();
  assert.deepEqual(harness.getDynamicRules(), []);
  assert.deepEqual(harness.updates, []);

  harness.setNow(new Date(2026, 7, 3, 22, 0));
  await sync();
  assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [91]);
  assert.deepEqual(harness.closedUrlBatches, [['night.example']]);

  for (const now of [
    new Date(2026, 7, 3, 23, 59),
    new Date(2026, 7, 4, 0, 0),
    new Date(2026, 7, 4, 5, 59)
  ]) {
    harness.setNow(now);
    await sync();
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [91]);
    assert.equal(harness.updates.length, 1);
    assert.equal(harness.closedUrlBatches.length, 1);
  }

  harness.setNow(new Date(2026, 7, 4, 6, 0));
  await sync();
  assert.deepEqual(harness.getDynamicRules(), []);
  assert.equal(harness.updates.length, 2);
  assert.deepEqual(harness.updates[1], { removeRuleIds: [91], addRules: [] });
});

test('Sunday-night browser protection survives the Monday weekday rollover', async () => {
  const harness = createTimedScheduleHarness({
    days: [0],
    initialNow: new Date(2026, 7, 9, 23, 45)
  });

  await harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  harness.setNow(new Date(2026, 7, 10, 4, 30));
  await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [91]);
  assert.equal(harness.updates.length, 1);
  assert.equal((await harness.synchronizer.inspectState()).inSync, true);
});

test('Friday-night browser protection continues into Saturday without enabling Saturday night', async () => {
  const harness = createTimedScheduleHarness({
    days: [5],
    initialNow: new Date(2026, 7, 8, 2, 30)
  });

  await harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [91]);

  harness.setNow(new Date(2026, 7, 8, 22, 30));
  await harness.synchronizer.requestSync({ reconcileExistingTabs: false });
  assert.deepEqual(harness.getDynamicRules(), []);
});

test('a late startup restores an already-active overnight rule and reconciles matching tabs', async () => {
  const harness = createTimedScheduleHarness({
    initialNow: new Date(2026, 7, 4, 3, 15)
  });

  const result = await harness.synchronizer.requestSync();

  assert.equal(result.success, true);
  assert.equal(result.added, 1);
  assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [91]);
  assert.deepEqual(harness.closedUrlBatches, [['night.example']]);
});

test('a late watchdog removes an overnight browser rule after its missed end boundary', async () => {
  const harness = createTimedScheduleHarness({
    initialNow: new Date(2026, 7, 4, 8, 45),
    currentDnrRules: [makeDnrRule({ id: 91, urlFilter: '||night.example' })]
  });

  const result = await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.equal(result.removed, 1);
  assert.deepEqual(harness.getDynamicRules(), []);
  assert.deepEqual(harness.closedUrlBatches, []);
});

test('overnight DNR activation still respects active profiles, categories, and disabled assignments', async () => {
  for (const configuration of [
    { listId: 'study', activeRuleListId: 'general' },
    { disabledCategories: ['social'] },
    { disabledByUser: true }
  ]) {
    const harness = createTimedScheduleHarness({
      ...configuration,
      initialNow: new Date(2026, 7, 4, 2, 0)
    });

    await harness.synchronizer.requestSync({ reconcileExistingTabs: false });
    assert.deepEqual(harness.getDynamicRules(), []);
    assert.deepEqual(harness.updates, []);
  }

  const selected = createTimedScheduleHarness({
    listId: 'study',
    activeRuleListId: 'study',
    initialNow: new Date(2026, 7, 4, 2, 0)
  });
  await selected.synchronizer.requestSync({ reconcileExistingTabs: false });
  assert.deepEqual(selected.getDynamicRules().map(rule => rule.id), [91]);
});

test('zero-duration scheduled assignments never create browser DNR rules', async () => {
  const harness = createTimedScheduleHarness({
    startTime: '22:00',
    endTime: '22:00',
    initialNow: new Date(2026, 7, 3, 22, 0)
  });

  await harness.synchronizer.requestSync({ reconcileExistingTabs: false });

  assert.deepEqual(harness.getDynamicRules(), []);
  assert.deepEqual(harness.updates, []);
});
