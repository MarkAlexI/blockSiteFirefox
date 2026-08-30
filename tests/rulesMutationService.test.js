import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRulesMutationService,
  serializeRulesMutationError
} from '../rules/rulesMutationService.js';
import { resolveRulePackEntries } from '../rules/rulePacks.js';
import { getRuleAssignment, getRuleListIds } from '../rules/ruleAssignments.js';
import { isRuleActiveNow } from '../rules/ruleActivation.js';
import { MAX_RULES_LIMIT } from '../utils/constants.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness({
  initialRules = [],
  initialRuleLists = [{ id: 'general', name: 'General', disabledCategories: [] }],
  initialActiveRuleListId = 'general',
  access = { isPro: true, isLegacyUser: false },
  syncResult = { success: true },
  validation = null,
  capacityValidation = null,
  combinedSaveError = null,
  settingsSaveError = null,
  usageRemapError = null,
  usageBatchRemapError = null,
  durableUsageJournal = false,
  usageStageError = null,
  usageRecoveryError = null,
  conflictObserver = null
} = {}) {
  let rules = clone(initialRules);
  let ruleLists = clone(initialRuleLists);
  let activeRuleListId = initialActiveRuleListId;
  let settings = { disabledCategories: [], enablePassword: false, passwordHash: null };
  const savedStates = [];
  const notifications = [];
  let syncCalls = 0;
  const usageRemaps = [];
  const usageRemapBatches = [];
  const usageJournalStages = [];
  let pendingUsageRemaps = [];
  const capacityChecks = [];
  const warnings = [];

  const rulesManager = {
    async getRules() {
      return clone(rules);
    },
    async saveRules(nextRules) {
      rules = clone(nextRules);
      savedStates.push(clone(nextRules));
    },
    validateRule(blockURL) {
      if (validation) return validation(blockURL);
      return blockURL.trim() ? { isValid: true, errors: [] } : {
        isValid: false,
        errors: ['blockurl_empty', 'blockurl_invalid']
      };
    },
    checkConflict(currentRules, blockURL, isWhitelist, excludeIndex = -1) {
      conflictObserver?.({
        candidateCount: currentRules.length,
        blockURL,
        isWhitelist
      });
      const cleanNew = blockURL.trim().toLowerCase();

      for (let index = 0; index < currentRules.length; index++) {
        if (excludeIndex !== -1 && index === excludeIndex) continue;

        const rule = currentRules[index];
        const ruleIsWhitelist = rule.isWhitelist === true;
        const cleanExisting = rule.blockURL.trim().toLowerCase();

        if (ruleIsWhitelist !== isWhitelist) {
          if (cleanNew.includes(cleanExisting) || cleanExisting.includes(cleanNew)) {
            return isWhitelist ? 'conflict_blacklist' : 'conflict_whitelist';
          }
        } else if (isWhitelist) {
          if (cleanNew.includes(cleanExisting) || cleanExisting.includes(cleanNew)) {
            return 'redundant_whitelist';
          }
        }
      }

      return null;
    },
    ruleExists(currentRules, blockURL, redirectURL, excludeIndex, isWhitelist) {
      return currentRules.some((rule, index) => {
        if (excludeIndex !== -1 && index === excludeIndex) return false;
        if ((rule.isWhitelist === true) !== isWhitelist) return false;
        return isWhitelist ?
          rule.blockURL === blockURL.trim() :
          rule.blockURL === blockURL.trim() && rule.redirectURL === redirectURL.trim();
      });
    }
  };

  const service = createRulesMutationService({
    rulesManager,
    ruleListsManager: {
      async getLists() { return clone(ruleLists); },
      async getState() { return { lists: clone(ruleLists), activeRuleListId }; },
      async saveLists(nextLists) { ruleLists = clone(nextLists); return clone(ruleLists); },
      async saveState(nextLists, nextActiveRuleListId) {
        ruleLists = clone(nextLists);
        activeRuleListId = nextActiveRuleListId;
        return { lists: clone(ruleLists), activeRuleListId };
      }
    },
    dnrSynchronizer: {
      async requestSync() {
        syncCalls++;
        return syncResult;
      },
      async validateRuleCapacity(nextRules, nextRuleListState = null) {
        capacityChecks.push({
          rules: clone(nextRules),
          ruleListState: nextRuleListState ? clone(nextRuleListState) : null
        });
        if (capacityValidation) return capacityValidation(nextRules, nextRuleListState);
        return { withinCapacity: true };
      }
    },
    dailyLimitManager: {
      async remapAssignmentKey(oldRuleId, oldListId, newRuleId, newListId) {
        if (usageRemapError) throw usageRemapError;
        usageRemaps.push({ oldRuleId, oldListId, newRuleId, newListId });
      },
      async remapAssignmentKeys(remaps) {
        if (usageBatchRemapError) throw usageBatchRemapError;
        usageRemapBatches.push(clone(remaps));
        usageRemaps.push(...clone(remaps));
      },
      ...(durableUsageJournal ? {
        async stagePendingRemaps(statePatch, remaps) {
          if (usageStageError) throw usageStageError;
          rules = clone(statePatch.rules);
          if (statePatch.ruleLists) ruleLists = clone(statePatch.ruleLists);
          if (statePatch.activeRuleListId) activeRuleListId = statePatch.activeRuleListId;
          savedStates.push(clone(statePatch.rules));
          pendingUsageRemaps.push(...clone(remaps));
          usageJournalStages.push({ statePatch: clone(statePatch), remaps: clone(remaps) });
        },
        async recoverPendingRemaps() {
          if (usageRecoveryError) throw usageRecoveryError;
          usageRemaps.push(...clone(pendingUsageRemaps));
          pendingUsageRemaps = [];
        }
      } : {})
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return [];
      }
    },
    getAccess: async () => access,
    getSettings: async () => clone(settings),
    saveSettings: async (nextSettings) => {
      if (settingsSaveError) throw settingsSaveError;
      settings = clone(nextSettings);
    },
    saveRulesAndLists: async (nextRules, nextLists, nextActiveRuleListId = null) => {
      if (combinedSaveError) throw combinedSaveError;
      rules = clone(nextRules);
      ruleLists = clone(nextLists);
      if (nextActiveRuleListId) activeRuleListId = nextActiveRuleListId;
      savedStates.push(clone(nextRules));
    },
    maxRulesLimit: MAX_RULES_LIMIT,
    resolveRulePackEntries,
    notifyRulesChanged(nextRules, extra) {
      notifications.push({ rules: clone(nextRules), extra: clone(extra) });
    },
    logger: {
      log() {},
      info() {},
      warn(...args) { warnings.push(args); },
      error() {}
    }
  });

  return {
    service,
    getRules: () => clone(rules),
    getSettings: () => clone(settings),
    getRuleLists: () => clone(ruleLists),
    getActiveRuleListId: () => activeRuleListId,
    savedStates,
    notifications,
    getSyncCalls: () => syncCalls,
    getUsageRemaps: () => clone(usageRemaps),
    getUsageRemapBatches: () => clone(usageRemapBatches),
    getUsageJournalStages: () => clone(usageJournalStages),
    getPendingUsageRemaps: () => clone(pendingUsageRemaps),
    getCapacityChecks: () => clone(capacityChecks),
    warnings
  };
}

function rejectDnrCapacity(expectedCount = 2, maximum = 1) {
  return {
    withinCapacity: false,
    limitType: 'unsafe_dynamic',
    expectedCount,
    expectedUnsafeCount: expectedCount,
    maxDynamicRules: 100,
    maxUnsafeDynamicRules: maximum
  };
}

function makeCapacityRule(id, listId = 'general', {
  disabledByUser = false,
  blockingMode = 'always'
} = {}) {
  return {
    id,
    blockURL: `rule-${id}.example`,
    redirectURL: '',
    category: 'social',
    isWhitelist: false,
    assignments: [{
      listId,
      disabledByUser,
      blockingMode,
      schedule: null,
      dailyLimit: blockingMode === 'daily_limit' ? { minutes: 15 } : null
    }]
  };
}

function makeScheduledCapacityRule(id = 1, schedule = {
  days: [1],
  startTime: '22:00',
  endTime: '06:00'
}) {
  const rule = makeCapacityRule(id);
  rule.assignments[0].blockingMode = 'schedule';
  rule.assignments[0].schedule = schedule;
  return rule;
}

test('browser DNR capacity rejects rule additions before storage or synchronization', async () => {
  const original = makeCapacityRule(1);
  const harness = createHarness({
    initialRules: [original],
    capacityValidation: () => rejectDnrCapacity()
  });

  await assert.rejects(
    harness.service.addRule({ blockURL: 'another.example', redirectURL: '' }),
    error => error.code === 'dnr_rule_limit_reached' &&
      /unsafe dynamic rule limit reached \(2\/1\)/.test(error.message)
  );

  assert.deepEqual(harness.getRules(), [original]);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 0);
});

test('oversized Rule Pack mutations preserve every previously stored rule', async () => {
  const original = makeCapacityRule(1);
  const harness = createHarness({
    initialRules: [original],
    capacityValidation: () => rejectDnrCapacity(3, 1)
  });

  await assert.rejects(
    harness.service.addMany({ packId: 'shopping', entryIds: ['amazon', 'etsy'] }),
    error => error.code === 'dnr_rule_limit_reached'
  );

  assert.deepEqual(harness.getRules(), [original]);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 0);
});

test('oversized imports do not replace rules, lists, active profiles, or settings', async () => {
  const original = makeCapacityRule(1);
  const harness = createHarness({
    initialRules: [original],
    capacityValidation: () => rejectDnrCapacity()
  });

  await assert.rejects(
    harness.service.replaceAll({
      rules: [
        { blockURL: 'first.example', redirectURL: '', listId: 'list-1' },
        { blockURL: 'second.example', redirectURL: '', listId: 'list-1' }
      ],
      ruleLists: [
        { id: 'general', name: 'General', disabledCategories: [] },
        { id: 'list-1', name: 'Study', disabledCategories: [] }
      ],
      activeRuleListId: 'list-1',
      settings: { mode: 'strict' }
    }),
    error => error.code === 'dnr_rule_limit_reached'
  );

  assert.deepEqual(harness.getRules(), [original]);
  assert.deepEqual(harness.getRuleLists().map(list => list.id), ['general']);
  assert.equal(harness.getActiveRuleListId(), 'general');
  assert.equal(harness.getSettings().mode, undefined);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getCapacityChecks()[0].ruleListState.activeRuleListId, 'list-1');
});

test('large inactive-profile imports stay linear and do not consume the active browser budget', async () => {
  const conflictChecks = [];
  const lists = [
    { id: 'general', name: 'General', disabledCategories: [] },
    { id: 'list-1', name: 'Archive', disabledCategories: [] }
  ];
  const harness = createHarness({
    conflictObserver: event => conflictChecks.push(event),
    capacityValidation: (rules, state) => {
      const activeCount = rules.filter(rule => getRuleAssignment(
        rule,
        state.activeRuleListId
      )).length;
      return activeCount <= 1
        ? { withinCapacity: true }
        : rejectDnrCapacity(activeCount, 1);
    }
  });
  const archived = Array.from({ length: 2_000 }, (_, index) => ({
    blockURL: `archive-${index}.example`,
    redirectURL: '',
    category: 'social',
    listId: 'list-1'
  }));

  const result = await harness.service.replaceAll({
    ruleLists: lists,
    activeRuleListId: 'general',
    rules: [
      ...archived,
      { blockURL: 'active.example', redirectURL: '', category: 'social' }
    ]
  });

  assert.equal(result.rules.length, 2_001);
  assert.equal(harness.getRules().length, 2_001);
  assert.equal(harness.getRules().at(-1).id, 2_001);
  assert.equal(harness.getCapacityChecks().length, 1);
  assert.equal(harness.getCapacityChecks()[0].ruleListState.activeRuleListId, 'general');
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.getSyncCalls(), 1);
  assert.deepEqual(conflictChecks, []);
});

test('large blacklist imports compare only existing whitelist candidates', async () => {
  const conflictChecks = [];
  const harness = createHarness({
    conflictObserver: event => conflictChecks.push(event)
  });
  const rules = [{
    blockURL: 'allowed.safe',
    redirectURL: '',
    isWhitelist: true
  }];
  for (let index = 0; index < 1_200; index++) {
    rules.push({
      blockURL: `blocked-${index}.example`,
      redirectURL: '',
      category: 'social'
    });
  }

  const result = await harness.service.replaceAll({ rules });

  assert.equal(result.rules.length, 1_201);
  assert.equal(conflictChecks.length, 1_200);
  assert.equal(conflictChecks.every(event =>
    event.candidateCount === 1 && event.isWhitelist === false
  ), true);
  assert.equal(harness.savedStates.length, 1);
});

test('late whitelist conflicts reject large imports atomically without quadratic blacklist scans', async () => {
  const original = makeCapacityRule(1);
  const conflictChecks = [];
  const harness = createHarness({
    initialRules: [original],
    conflictObserver: event => conflictChecks.push(event)
  });
  const rules = Array.from({ length: 1_000 }, (_, index) => ({
    blockURL: `blocked-${index}.example`,
    redirectURL: ''
  }));
  rules.push({
    blockURL: 'blocked-777.example/private',
    redirectURL: '',
    isWhitelist: true
  });

  await assert.rejects(
    harness.service.replaceAll({
      rules,
      settings: { mode: 'strict' }
    }),
    error => error.code === 'conflict_blacklist'
  );

  assert.deepEqual(conflictChecks, [{
    candidateCount: 1_000,
    blockURL: 'blocked-777.example/private',
    isWhitelist: true
  }]);
  assert.deepEqual(harness.getRules(), [original]);
  assert.equal(harness.getSettings().mode, undefined);
  assert.deepEqual(harness.getCapacityChecks(), []);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 0);
});

test('invalid imported rule entries fail clearly without replacing rules or settings', async () => {
  for (const invalidRule of [null, true, 4, 'example.com', []]) {
    const original = makeCapacityRule(1);
    const harness = createHarness({ initialRules: [original] });

    await assert.rejects(
      harness.service.replaceAll({
        rules: [{ blockURL: 'valid.example', redirectURL: '' }, invalidRule],
        settings: { mode: 'strict' }
      }),
      error => error.code === 'invalid_import' &&
        error.message === 'Invalid file format: rule 2 must be an object'
    );

    assert.deepEqual(harness.getRules(), [original]);
    assert.equal(harness.getSettings().mode, undefined);
    assert.deepEqual(harness.getCapacityChecks(), []);
    assert.equal(harness.savedStates.length, 0);
  }
});

test('indexed import collision checks preserve normalized same-profile rejection', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.replaceAll({
      rules: [
        {
          blockURL: '  BLOCKED.Example ',
          redirectURL: '',
          category: 'social'
        },
        {
          blockURL: 'blocked.example',
          redirectURL: 'https://redirect.example/',
          category: 'work'
        }
      ]
    }),
    error => error.code === 'rule_already_exists' &&
      error.message === 'This URL already has a target in this list'
  );

  assert.deepEqual(harness.getRules(), []);
  assert.equal(harness.savedStates.length, 0);
});

test('indexed import keys still reject duplicate exact targets across disjoint profiles', async () => {
  const harness = createHarness();
  const ruleLists = [
    { id: 'general', name: 'General', disabledCategories: [] },
    { id: 'list-1', name: 'Study', disabledCategories: [] }
  ];

  await assert.rejects(
    harness.service.replaceAll({
      ruleLists,
      rules: [
        {
          blockURL: 'Same.Example',
          redirectURL: 'https://redirect.example/',
          category: 'social',
          listId: 'general'
        },
        {
          blockURL: ' same.example ',
          redirectURL: ' https://redirect.example/ ',
          category: 'social',
          listId: 'list-1'
        }
      ]
    }),
    error => error.code === 'rule_already_exists' &&
      error.message === 'Rule already exists'
  );

  assert.deepEqual(harness.getRuleLists().map(list => list.id), ['general']);
  assert.equal(harness.savedStates.length, 0);
});

test('indexed imports preserve original whitelist and blacklist conflict precedence', async () => {
  const firstWhitelist = createHarness();
  await assert.rejects(
    firstWhitelist.service.replaceAll({
      rules: [
        { blockURL: 'allowed.example', isWhitelist: true },
        { blockURL: 'blocked.example', redirectURL: '' },
        { blockURL: 'allowed.example/blocked.example', isWhitelist: true }
      ]
    }),
    error => error.code === 'redundant_whitelist'
  );

  const firstBlacklist = createHarness();
  await assert.rejects(
    firstBlacklist.service.replaceAll({
      rules: [
        { blockURL: 'blocked.example', redirectURL: '' },
        { blockURL: 'allowed.example', isWhitelist: true },
        { blockURL: 'blocked.example/allowed.example', isWhitelist: true }
      ]
    }),
    error => error.code === 'conflict_blacklist'
  );

  assert.equal(firstWhitelist.savedStates.length, 0);
  assert.equal(firstBlacklist.savedStates.length, 0);
});

test('indexed blacklist imports preserve case-insensitive whitelist protection', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.replaceAll({
      rules: [
        { blockURL: 'Allowed.Example', isWhitelist: true },
        { blockURL: 'sub.ALLOWED.example', redirectURL: '' }
      ]
    }),
    error => error.code === 'conflict_whitelist'
  );

  assert.deepEqual(harness.getRules(), []);
  assert.equal(harness.getSyncCalls(), 0);
});

test('a rejected local import write cannot change independently stored settings', async () => {
  const original = makeCapacityRule(1);
  const harness = createHarness({
    initialRules: [original],
    combinedSaveError: new Error('local storage quota exceeded')
  });

  await assert.rejects(
    harness.service.replaceAll({
      rules: [{ blockURL: 'imported.example', redirectURL: '' }],
      settings: { mode: 'strict' }
    }),
    /local storage quota exceeded/
  );

  assert.deepEqual(harness.getRules(), [original]);
  assert.equal(harness.getSettings().mode, undefined);
  assert.equal(harness.getSyncCalls(), 0);
});

test('optional settings failure cannot hide or desynchronize a committed rule import', async () => {
  const harness = createHarness({
    settingsSaveError: new Error('sync storage unavailable')
  });

  const result = await harness.service.replaceAll({
    rules: [{ blockURL: 'imported.example', redirectURL: '' }],
    settings: { mode: 'strict' }
  });

  assert.deepEqual(harness.getRules().map(rule => rule.blockURL), ['imported.example']);
  assert.equal(result.settings, null);
  assert.equal(result.settingsSyncPending, true);
  assert.equal(harness.getSettings().mode, undefined);
  assert.equal(harness.getSyncCalls(), 1);
  assert.equal(harness.warnings.length, 1);
});

test('reactivating a rule validates DNR capacity but Free disabling always remains available', async () => {
  const disabledHarness = createHarness({
    initialRules: [makeCapacityRule(1, 'general', { disabledByUser: true })],
    access: { isPro: false, isLegacyUser: false },
    capacityValidation: () => rejectDnrCapacity()
  });

  await assert.rejects(
    disabledHarness.service.toggleRule({ ruleId: 1 }),
    error => error.code === 'dnr_rule_limit_reached'
  );
  assert.equal(getRuleAssignment(disabledHarness.getRules()[0], 'general').disabledByUser, true);

  const enabledHarness = createHarness({
    initialRules: [makeCapacityRule(1)],
    access: { isPro: false, isLegacyUser: false },
    capacityValidation: () => rejectDnrCapacity()
  });
  const result = await enabledHarness.service.toggleRule({ ruleId: 1 });

  assert.equal(result.assignment.disabledByUser, true);
  assert.equal(enabledHarness.getCapacityChecks().length, 0);
  assert.equal(enabledHarness.getSyncCalls(), 1);
});

test('Free deletion and custom-assignment cleanup never depend on DNR capacity preflight', async () => {
  const shared = makeCapacityRule(1);
  shared.assignments.push({
    listId: 'study',
    disabledByUser: false,
    blockingMode: 'always',
    schedule: null,
    dailyLimit: null
  });
  const harness = createHarness({
    initialRules: [shared, makeCapacityRule(2)],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    access: { isPro: false, isLegacyUser: false },
    capacityValidation: () => rejectDnrCapacity()
  });

  await harness.service.removeAssignment({ ruleId: 1, listId: 'study' });
  await harness.service.deleteRule({ ruleId: 2 });
  await harness.service.removeAssignment({ ruleId: 1, listId: 'general' });

  assert.deepEqual(harness.getRules(), []);
  assert.equal(harness.getCapacityChecks().length, 0);
  assert.equal(harness.getSyncCalls(), 3);
});

test('activating an oversized Rule List preserves the existing active profile', async () => {
  const harness = createHarness({
    initialRules: [makeCapacityRule(1), makeCapacityRule(2, 'study')],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    capacityValidation: (_rules, state) => state?.activeRuleListId === 'study'
      ? rejectDnrCapacity()
      : { withinCapacity: true }
  });

  await assert.rejects(
    harness.service.activateRuleList({ listId: 'study' }),
    error => error.code === 'dnr_rule_limit_reached'
  );

  assert.equal(harness.getActiveRuleListId(), 'general');
  assert.equal(harness.getSyncCalls(), 0);
});

test('reenabling an oversized category preserves its disabled profile state', async () => {
  const harness = createHarness({
    initialRules: [makeCapacityRule(1)],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: ['social'] }
    ],
    capacityValidation: () => rejectDnrCapacity()
  });

  await assert.rejects(
    harness.service.toggleCategory({ category: 'social' }),
    error => error.code === 'dnr_rule_limit_reached'
  );

  assert.deepEqual(harness.getRuleLists()[0].disabledCategories, ['social']);
  assert.equal(harness.getSyncCalls(), 0);
});

test('Rule List deletion checks the projected General profile before committing', async () => {
  const harness = createHarness({
    initialRules: [makeCapacityRule(1), makeCapacityRule(2, 'study')],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'study',
    capacityValidation: () => rejectDnrCapacity()
  });

  await assert.rejects(
    harness.service.deleteRuleList({ listId: 'study' }),
    error => error.code === 'dnr_rule_limit_reached'
  );

  assert.deepEqual(harness.getRuleLists().map(list => list.id), ['general', 'study']);
  assert.equal(harness.getActiveRuleListId(), 'study');
  assert.equal(harness.savedStates.length, 0);
});

test('failed post-commit Daily Limit remaps do not prevent updated rules from synchronizing', async () => {
  const harness = createHarness({
    initialRules: [makeCapacityRule(1, 'study', { blockingMode: 'daily_limit' })],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    usageRemapError: new Error('usage storage unavailable')
  });

  const result = await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'study',
    blockURL: 'rule-1.example',
    redirectURL: '',
    category: 'social',
    assignment: {
      listId: 'general',
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 15 }
    }
  });

  assert.equal(result.dailyUsageSyncPending, true);
  assert.equal(getRuleAssignment(harness.getRules()[0], 'general').blockingMode, 'daily_limit');
  assert.equal(harness.getSyncCalls(), 1);
  assert.equal(harness.warnings.length, 1);
});

test('failed batched Daily Limit remaps do not undo a committed Rule List deletion', async () => {
  const harness = createHarness({
    initialRules: [makeCapacityRule(1, 'study', { blockingMode: 'daily_limit' })],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'study',
    usageBatchRemapError: new Error('batched usage storage unavailable')
  });

  const result = await harness.service.deleteRuleList({ listId: 'study' });

  assert.equal(result.dailyUsageSyncPending, true);
  assert.equal(harness.getActiveRuleListId(), 'general');
  assert.deepEqual(harness.getRuleLists().map(list => list.id), ['general']);
  assert.equal(getRuleAssignment(harness.getRules()[0], 'general').blockingMode, 'daily_limit');
  assert.equal(harness.getSyncCalls(), 1);
  assert.equal(harness.warnings.length, 1);
});

test('Daily Limit assignment edits commit their durable remap with the updated rules', async () => {
  const harness = createHarness({
    initialRules: [makeCapacityRule(1, 'study', { blockingMode: 'daily_limit' })],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    durableUsageJournal: true
  });

  const result = await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'study',
    blockURL: 'rule-1.example',
    redirectURL: '',
    category: 'social',
    assignment: {
      listId: 'general',
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 15 }
    }
  });

  assert.equal(result.dailyUsageSyncPending, undefined);
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.getUsageJournalStages().length, 1);
  assert.deepEqual(harness.getUsageRemaps(), [{
    oldRuleId: 1, oldListId: 'study', newRuleId: 1, newListId: 'general'
  }]);
  assert.deepEqual(harness.getPendingUsageRemaps(), []);
  assert.equal(harness.getSyncCalls(), 1);
});

test('failed durable remap staging leaves rules and browser synchronization untouched', async () => {
  const original = makeCapacityRule(1, 'study', { blockingMode: 'daily_limit' });
  const harness = createHarness({
    initialRules: [original],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    durableUsageJournal: true,
    usageStageError: new Error('atomic usage journal could not be saved')
  });

  await assert.rejects(harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'study',
    blockURL: 'rule-1.example',
    redirectURL: '',
    category: 'social',
    assignment: {
      listId: 'general',
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 15 }
    }
  }), /journal could not be saved/);

  assert.deepEqual(harness.getRules(), [original]);
  assert.equal(harness.savedStates.length, 0);
  assert.deepEqual(harness.getUsageJournalStages(), []);
  assert.equal(harness.getSyncCalls(), 0);
});

test('failed durable recovery leaves its remap pending after a successful committed edit', async () => {
  const harness = createHarness({
    initialRules: [makeCapacityRule(1, 'study', { blockingMode: 'daily_limit' })],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    durableUsageJournal: true,
    usageRecoveryError: new Error('usage recovery is temporarily unavailable')
  });

  const result = await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'study',
    blockURL: 'rule-1.example',
    redirectURL: '',
    category: 'social',
    assignment: {
      listId: 'general',
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 15 }
    }
  });

  assert.equal(result.dailyUsageSyncPending, true);
  assert.equal(harness.getUsageJournalStages().length, 1);
  assert.deepEqual(harness.getPendingUsageRemaps(), [{
    oldRuleId: 1, oldListId: 'study', newRuleId: 1, newListId: 'general'
  }]);
  assert.equal(harness.getSyncCalls(), 1);
  assert.equal(harness.warnings.length, 1);
});

test('ordinary assignment moves never create unnecessary durable usage journal writes', async () => {
  const harness = createHarness({
    initialRules: [makeCapacityRule(1, 'study')],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    durableUsageJournal: true
  });

  await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'study',
    blockURL: 'rule-1.example',
    redirectURL: '',
    category: 'social',
    assignment: { listId: 'general', blockingMode: 'always' }
  });

  assert.equal(harness.savedStates.length, 1);
  assert.deepEqual(harness.getUsageJournalStages(), []);
});

test('Rule List deletion stages all paid usage moves with its one local state commit', async () => {
  const harness = createHarness({
    initialRules: [
      makeCapacityRule(1, 'study', { blockingMode: 'daily_limit' }),
      makeCapacityRule(2, 'study', { blockingMode: 'daily_limit' }),
      makeCapacityRule(3, 'study')
    ],
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'study',
    durableUsageJournal: true,
    usageRecoveryError: new Error('batched usage recovery is temporarily unavailable')
  });

  const result = await harness.service.deleteRuleList({ listId: 'study' });

  assert.equal(result.dailyUsageSyncPending, true);
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.getUsageJournalStages().length, 1);
  assert.deepEqual(harness.getPendingUsageRemaps().map(remap => remap.oldRuleId), [1, 2]);
  assert.equal(harness.getUsageJournalStages()[0].statePatch.activeRuleListId, 'general');
  assert.deepEqual(harness.getRuleLists().map(list => list.id), ['general']);
  assert.equal(harness.getSyncCalls(), 1);
});

test('concurrent additions are serialized and receive unique IDs', async () => {
  const harness = createHarness();

  await Promise.all([
    harness.service.addRule({ blockURL: 'first.example', redirectURL: '' }),
    harness.service.addRule({ blockURL: 'second.example', redirectURL: '' })
  ]);

  assert.deepEqual(
    harness.getRules().map(rule => [rule.id, rule.blockURL]),
    [[1, 'first.example'], [2, 'second.example']]
  );
  assert.equal(harness.savedStates.length, 2);
});

test('an add and delete operation do not overwrite each other', async () => {
  const harness = createHarness({
    initialRules: [{
      id: 1,
      blockURL: 'old.example',
      redirectURL: '',
      schedule: null,
      category: 'social',
      disabledByUser: false,
      isWhitelist: false
    }]
  });

  await Promise.all([
    harness.service.addRule({ blockURL: 'new.example', redirectURL: '' }),
    harness.service.deleteRule({ ruleId: 1 })
  ]);

  assert.deepEqual(
    harness.getRules().map(rule => rule.blockURL),
    ['new.example']
  );
});

test('updates target a stable rule ID instead of a stale UI index', async () => {
  const harness = createHarness({
    initialRules: [
      { id: 10, blockURL: 'first.example', redirectURL: '', category: 'social', disabledByUser: false, isWhitelist: false },
      { id: 20, blockURL: 'second.example', redirectURL: '', category: 'social', disabledByUser: false, isWhitelist: false }
    ]
  });

  await harness.service.updateRule({
    ruleId: 20,
    blockURL: 'updated.example',
    redirectURL: '',
    category: 'social',
    schedule: null,
    disabledByUser: false
  });

  assert.equal(harness.getRules()[0].blockURL, 'first.example');
  assert.equal(harness.getRules()[1].id, 20);
  assert.equal(harness.getRules()[1].blockURL, 'updated.example');
});

test('validation errors preserve the complete array of localization keys', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.addRule({ blockURL: '', redirectURL: '' }),
    (error) => {
      assert.equal(error.code, 'validation_failed');
      assert.deepEqual(error.validationErrors, ['blockurl_empty', 'blockurl_invalid']);
      assert.deepEqual(
        serializeRulesMutationError(error).validationErrors,
        ['blockurl_empty', 'blockurl_invalid']
      );
      return true;
    }
  );

  assert.equal(harness.savedStates.length, 0);
});

test('invalid replacement does not clear or overwrite existing rules', async () => {
  const originalRule = {
    id: 7,
    blockURL: 'keep.example',
    redirectURL: '',
    category: 'social',
    disabledByUser: false,
    isWhitelist: false
  };
  const harness = createHarness({ initialRules: [originalRule] });

  await assert.rejects(
    harness.service.replaceAll({ rules: [{ blockURL: '', redirectURL: '' }] }),
    error => error.code === 'validation_failed'
  );

  assert.deepEqual(harness.getRules(), [originalRule]);
  assert.equal(harness.savedStates.length, 0);
});

test('replacement writes the complete imported state once without an empty intermediate state', async () => {
  const harness = createHarness({
    initialRules: [{ id: 9, blockURL: 'old.example', redirectURL: '', category: 'social', disabledByUser: false, isWhitelist: false }]
  });

  await harness.service.replaceAll({
    rules: [
      { blockURL: 'one.example', redirectURL: '', category: 'social' },
      { blockURL: 'two.example', redirectURL: '', category: 'work' }
    ]
  });

  assert.equal(harness.savedStates.length, 1);
  assert.deepEqual(
    harness.savedStates[0].map(rule => [rule.id, rule.blockURL]),
    [[1, 'one.example'], [2, 'two.example']]
  );
});

test('a DNR sync failure keeps the saved rule and reports syncPending', async () => {
  const harness = createHarness({
    syncResult: { success: false, error: 'temporary DNR failure' }
  });

  const result = await harness.service.addRule({
    blockURL: 'saved.example',
    redirectURL: ''
  });

  assert.equal(harness.getRules()[0].blockURL, 'saved.example');
  assert.equal(result.syncPending, true);
  assert.equal(harness.notifications[0].extra.syncPending, true);
});

test('the free rule limit is enforced inside the worker mutation service', async () => {
  const initialRules = Array.from({ length: MAX_RULES_LIMIT }, (_, index) => ({
    id: index + 1,
    blockURL: `site-${index}.example`,
    redirectURL: '',
    category: 'social',
    disabledByUser: false,
    isWhitelist: false
  }));
  const harness = createHarness({
    initialRules,
    access: { isPro: false, isLegacyUser: false }
  });

  await assert.rejects(
    harness.service.addRule({ blockURL: 'blocked-by-limit.example', redirectURL: '' }),
    error => error.code === 'rule_limit_reached'
  );

  assert.equal(harness.getRules().length, MAX_RULES_LIMIT);
});

test('Free additions ignore nineteen preserved targets assigned only to custom profiles', async () => {
  const study = { id: 'list-1', name: 'Study', disabledCategories: [] };
  const initialRules = Array.from({ length: 19 }, (_, index) => ({
    id: index + 1,
    blockURL: `study-${index}.example`,
    redirectURL: '',
    category: 'social',
    isWhitelist: false,
    assignments: [{ listId: study.id, blockingMode: 'always' }]
  }));
  const harness = createHarness({
    initialRules,
    initialRuleLists: [{ id: 'general', name: 'General', disabledCategories: [] }, study],
    access: { isPro: false, isLegacyUser: false }
  });

  const result = await harness.service.addRule({
    blockURL: 'free-general.example',
    redirectURL: ''
  });

  assert.equal(result.rule.id, 20);
  assert.equal(harness.getRules().length, 20);
  assert.deepEqual(getRuleListIds(result.rule), ['general']);
  assert.equal(harness.getRules().slice(0, 19).every(rule => getRuleListIds(rule)[0] === study.id), true);
});

test('inherited whitelist targets do not consume the ten-rule Free blacklist quota', async () => {
  const generalRules = Array.from({ length: MAX_RULES_LIMIT - 1 }, (_, index) => ({
    id: index + 1,
    blockURL: `general-${index}.example`,
    redirectURL: '',
    category: 'social',
    isWhitelist: false
  }));
  const harness = createHarness({
    initialRules: [...generalRules, {
      id: MAX_RULES_LIMIT,
      blockURL: 'allowed.example',
      redirectURL: '',
      category: 'whitelist',
      isWhitelist: true
    }],
    access: { isPro: false, isLegacyUser: false }
  });

  await harness.service.addRule({ blockURL: 'tenth-general.example', redirectURL: '' });

  assert.equal(harness.getRules().length, MAX_RULES_LIMIT + 1);
  assert.equal(harness.getRules().filter(rule => !rule.isWhitelist).length, MAX_RULES_LIMIT);
});

test('adding General to an existing custom-only target still enforces the Free quota', async () => {
  const initialRules = Array.from({ length: MAX_RULES_LIMIT }, (_, index) => ({
    id: index + 1,
    blockURL: `general-${index}.example`,
    redirectURL: '',
    category: 'social',
    isWhitelist: false
  }));
  initialRules.push({
    id: MAX_RULES_LIMIT + 1,
    blockURL: 'study-only.example',
    redirectURL: '',
    category: 'social',
    isWhitelist: false,
    assignments: [{ listId: 'list-1', blockingMode: 'always' }]
  });
  const harness = createHarness({
    initialRules,
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    access: { isPro: false, isLegacyUser: false }
  });

  await assert.rejects(
    harness.service.addRule({ blockURL: 'study-only.example', redirectURL: '', category: 'social' }),
    error => error.code === 'rule_limit_reached'
  );

  assert.deepEqual(getRuleListIds(harness.getRules().at(-1)), ['list-1']);
});

test('Free users can reuse a preserved custom target when General remains below its quota', async () => {
  const initialRules = Array.from({ length: MAX_RULES_LIMIT - 1 }, (_, index) => ({
    id: index + 1,
    blockURL: `general-${index}.example`,
    redirectURL: '',
    category: 'social',
    isWhitelist: false
  }));
  initialRules.push({
    id: MAX_RULES_LIMIT,
    blockURL: 'shared.example',
    redirectURL: '',
    category: 'social',
    isWhitelist: false,
    assignments: [{ listId: 'list-1', blockingMode: 'always' }]
  });
  const harness = createHarness({
    initialRules,
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    access: { isPro: false, isLegacyUser: false }
  });

  const result = await harness.service.addRule({
    blockURL: 'shared.example',
    redirectURL: '',
    category: 'social'
  });

  assert.equal(result.assignmentAdded, true);
  assert.deepEqual(getRuleListIds(result.rule).sort(), ['general', 'list-1']);
  assert.equal(harness.getRules().length, MAX_RULES_LIMIT);
});

test('updating a preserved custom-only target cannot bypass the ten-rule Free quota', async () => {
  const initialRules = Array.from({ length: MAX_RULES_LIMIT }, (_, index) => ({
    id: index + 1,
    blockURL: `general-${index}.example`,
    redirectURL: '',
    category: 'social',
    isWhitelist: false
  }));
  initialRules.push({
    id: MAX_RULES_LIMIT + 1,
    blockURL: 'study-only.example',
    redirectURL: '',
    category: 'social',
    isWhitelist: false,
    assignments: [{ listId: 'list-1', blockingMode: 'always' }]
  });
  const harness = createHarness({
    initialRules,
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    access: { isPro: false, isLegacyUser: false }
  });

  for (const assignmentListId of ['list-1', undefined]) {
    await assert.rejects(
      harness.service.updateRule({
        ruleId: MAX_RULES_LIMIT + 1,
        assignmentListId,
        blockURL: 'study-only.example',
        redirectURL: '',
        category: 'social',
        assignment: { listId: 'general', blockingMode: 'always' }
      }),
      error => error.code === 'rule_limit_reached'
    );
  }

  assert.deepEqual(getRuleListIds(harness.getRules().at(-1)), ['list-1']);
});

test('updating an existing General rule remains available above the inherited Free quota', async () => {
  const initialRules = Array.from({ length: 19 }, (_, index) => ({
    id: index + 1,
    blockURL: `general-${index}.example`,
    redirectURL: '',
    category: 'social',
    isWhitelist: false
  }));
  const harness = createHarness({
    initialRules,
    access: { isPro: false, isLegacyUser: false }
  });

  await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'general',
    blockURL: 'updated-general.example',
    redirectURL: '',
    category: 'social',
    assignment: { listId: 'general', blockingMode: 'always' }
  });

  assert.equal(harness.getRules()[0].blockURL, 'updated-general.example');
  assert.equal(harness.getRules().length, 19);
});

test('clear saves an empty state and delegates complete DNR removal to the synchronizer', async () => {
  const harness = createHarness({
    initialRules: [{ id: 1, blockURL: 'clear.example', redirectURL: '', category: 'social', disabledByUser: false, isWhitelist: false }]
  });

  const result = await harness.service.clearRules();

  assert.deepEqual(result.rules, []);
  assert.deepEqual(harness.getRules(), []);
  assert.equal(harness.getSyncCalls(), 1);
});

test('non-Pro callers cannot import or clear rules through direct intents', async () => {
  const originalRule = {
    id: 1,
    blockURL: 'protected.example',
    redirectURL: '',
    category: 'social',
    disabledByUser: false,
    isWhitelist: false
  };
  const harness = createHarness({
    initialRules: [originalRule],
    access: { isPro: false, isLegacyUser: false }
  });

  await assert.rejects(
    harness.service.replaceAll({ rules: [{ blockURL: 'imported.example', redirectURL: '' }] }),
    error => error.code === 'pro_required'
  );
  await assert.rejects(
    harness.service.clearRules(),
    error => error.code === 'pro_required'
  );

  assert.deepEqual(harness.getRules(), [originalRule]);
  assert.equal(harness.savedStates.length, 0);
});

test('non-Pro callers cannot edit an existing whitelist rule through a direct intent', async () => {
  const originalRule = {
    id: 4,
    blockURL: 'allowed.example',
    redirectURL: '',
    schedule: null,
    category: 'whitelist',
    disabledByUser: false,
    isWhitelist: true
  };
  const harness = createHarness({
    initialRules: [originalRule],
    access: { isPro: false, isLegacyUser: false }
  });

  await assert.rejects(
    harness.service.updateRule({
      ruleId: 4,
      blockURL: 'changed.example',
      redirectURL: '',
      category: 'whitelist'
    }),
    error => error.code === 'pro_required'
  );

  assert.deepEqual(harness.getRules(), [originalRule]);
});

test('category blocking can be disabled and enabled again without changing stored rules', async () => {
  const originalRules = [{
    id: 1,
    blockURL: 'social.example',
    redirectURL: '',
    category: 'social',
    disabledByUser: false,
    isWhitelist: false
  }];
  const harness = createHarness({ initialRules: originalRules });

  const disabledResult = await harness.service.toggleCategory({ category: 'social' });

  assert.deepEqual(harness.getRuleLists()[0].disabledCategories, ['social']);
  assert.equal(disabledResult.activeRuleListId, 'general');
  assert.deepEqual(harness.getRules(), originalRules);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 1);

  const enabledResult = await harness.service.toggleCategory({ category: 'social' });

  assert.deepEqual(harness.getRuleLists()[0].disabledCategories, []);
  assert.equal(enabledResult.activeRuleListId, 'general');
  assert.deepEqual(harness.getRules(), originalRules);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 2);
});

test('category blocking state is independent between Rule List profiles', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: ['news'] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'list-1'
  });

  await harness.service.toggleCategory({ category: 'social' });

  assert.deepEqual(harness.getRuleLists(), [
    { id: 'general', name: 'General', disabledCategories: ['news'] },
    { id: 'list-1', name: 'Study', disabledCategories: ['social'] }
  ]);
  assert.equal(harness.getActiveRuleListId(), 'list-1');

  await harness.service.activateRuleList({ listId: 'general' });
  assert.equal(harness.getActiveRuleListId(), 'general');
  assert.deepEqual(harness.getRuleLists()[0].disabledCategories, ['news']);
});

test('category blocking changes require Pro or legacy access', async () => {
  const harness = createHarness({
    access: { isPro: false, isLegacyUser: false }
  });

  await assert.rejects(
    harness.service.toggleCategory({ category: 'social' }),
    error => error.code === 'pro_required'
  );

  assert.deepEqual(harness.getSettings().disabledCategories, []);
  assert.equal(harness.getSyncCalls(), 0);
});


test('a selected rule pack is added with one storage write and one DNR sync', async () => {
  const harness = createHarness();

  const result = await harness.service.addMany({
    packId: 'shopping',
    entryIds: ['amazon', 'etsy']
  });

  assert.equal(result.addedCount, 2);
  assert.equal(result.skippedDuplicates, 0);
  assert.deepEqual(result.addedEntries, [
    { entryId: 'amazon', blockURL: 'amazon.com' },
    { entryId: 'etsy', blockURL: 'etsy.com' }
  ]);
  assert.deepEqual(result.duplicateEntries, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(
    harness.getRules().map(rule => [rule.id, rule.blockURL, rule.category]),
    [
      [1, 'amazon.com', 'shopping'],
      [2, 'etsy.com', 'shopping']
    ]
  );
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.getSyncCalls(), 1);
});

test('the short-form video pack persists its exact path targets atomically', async () => {
  const harness = createHarness();

  const result = await harness.service.addMany({
    packId: 'short-video',
    entryIds: [
      'youtube-shorts',
      'tiktok-short-video',
      'instagram-reels',
      'facebook-reels'
    ]
  });

  assert.equal(result.addedCount, 4);
  assert.deepEqual(harness.getRules().map(rule => [rule.blockURL, rule.category]), [
    ['youtube.com/shorts', 'entertainment'],
    ['tiktok.com', 'entertainment'],
    ['instagram.com/reel', 'entertainment'],
    ['facebook.com/reel', 'entertainment']
  ]);
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.getSyncCalls(), 1);
});

test('rule packs are assigned to the selected custom Rule List', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Study', disabled: false }
    ]
  });

  const result = await harness.service.addMany({
    packId: 'shopping',
    entryIds: ['amazon', 'etsy'],
    listId: 'list-1'
  });

  assert.equal(result.listId, 'list-1');
  assert.deepEqual(harness.getRules().map(rule => getRuleListIds(rule)), [['list-1'], ['list-1']]);
});

test('rule packs reject unknown Rule List targets before changing storage', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.addMany({
      packId: 'shopping',
      entryIds: ['amazon'],
      listId: 'missing-list'
    }),
    error => error.code === 'rule_list_not_found'
  );

  assert.deepEqual(harness.getRules(), []);
  assert.equal(harness.savedStates.length, 0);
});

test('rule pack import skips exact duplicates and reports whitelist conflicts', async () => {
  const harness = createHarness({
    initialRules: [
      {
        id: 1,
        blockURL: 'amazon.com',
        redirectURL: '',
        category: 'shopping',
        disabledByUser: false,
        isWhitelist: false
      },
      {
        id: 2,
        blockURL: 'etsy.com',
        redirectURL: '',
        schedule: null,
        category: 'whitelist',
        disabledByUser: false,
        isWhitelist: true
      }
    ]
  });

  const result = await harness.service.addMany({
    packId: 'shopping',
    entryIds: ['amazon', 'etsy', 'temu']
  });

  assert.equal(result.addedCount, 1);
  assert.equal(result.skippedDuplicates, 1);
  assert.deepEqual(result.addedEntries, [{
    entryId: 'temu',
    blockURL: 'temu.com'
  }]);
  assert.deepEqual(result.duplicateEntries, [{
    entryId: 'amazon',
    blockURL: 'amazon.com'
  }]);
  assert.deepEqual(result.conflicts, [{
    entryId: 'etsy',
    blockURL: 'etsy.com',
    code: 'conflict_whitelist'
  }]);
  assert.equal(harness.getRules().at(-1).blockURL, 'temu.com');
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.getSyncCalls(), 1);
});

test('a rule pack with no new entries does not write storage or synchronize DNR', async () => {
  const harness = createHarness({
    initialRules: [{
      id: 1,
      blockURL: 'amazon.com',
      redirectURL: '',
      category: 'shopping',
      disabledByUser: false,
      isWhitelist: false
    }]
  });

  const result = await harness.service.addMany({
    packId: 'shopping',
    entryIds: ['amazon']
  });

  assert.equal(result.addedCount, 0);
  assert.equal(result.skippedDuplicates, 1);
  assert.deepEqual(result.addedEntries, []);
  assert.deepEqual(result.duplicateEntries, [{
    entryId: 'amazon',
    blockURL: 'amazon.com'
  }]);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 0);
});

test('rule packs require Pro or legacy access', async () => {
  const harness = createHarness({
    access: { isPro: false, isLegacyUser: false }
  });

  await assert.rejects(
    harness.service.addMany({ packId: 'social', entryIds: ['facebook'] }),
    error => error.code === 'pro_required'
  );

  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 0);
});

test('unknown pack entries fail before any stored rule is changed', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.addMany({ packId: 'social', entryIds: ['facebook', 'unknown-entry'] }),
    error => error.code === 'rule_pack_invalid_selection'
  );

  assert.equal(harness.savedStates.length, 0);
  assert.deepEqual(harness.getRules(), []);
});

test('a shared Rule Pack schedule is normalized and applied to every added rule', async () => {
  const harness = createHarness();

  const result = await harness.service.addMany({
    packId: 'shopping',
    entryIds: ['amazon', 'etsy'],
    schedule: {
      days: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '17:00'
    }
  });

  assert.equal(result.scheduleApplied, true);
  const schedules = harness.getRules().map(rule => getRuleAssignment(rule, 'general').schedule);
  assert.deepEqual(
    schedules,
    [
      {
        version: 2,
        periods: [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' }]
      },
      {
        version: 2,
        periods: [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' }]
      }
    ]
  );
  assert.notEqual(schedules[0], schedules[1]);
  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.getSyncCalls(), 1);
});

test('an invalid shared Rule Pack schedule fails before storage or DNR changes', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.addMany({
      packId: 'social',
      entryIds: ['facebook'],
      schedule: {
        version: 2,
        periods: [{ days: [], startTime: '18:00', endTime: '18:00' }]
      }
    }),
    error => {
      assert.equal(error.code, 'validation_failed');
      assert.deepEqual(error.validationErrors, ['invalid_days', 'start_after_end']);
      return true;
    }
  );

  assert.deepEqual(harness.getRules(), []);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 0);
});


test('custom rule lists are Pro-only and new rules can be assigned to them', async () => {
  const harness = createHarness();
  const created = await harness.service.createRuleList({ name: 'Work' });
  const workList = created.list;

  assert.equal(workList.id, 'list-1');
  assert.equal(workList.name, 'Work');
  assert.equal(created.activeRuleListId, workList.id);
  assert.equal(harness.getActiveRuleListId(), workList.id);
  assert.equal(harness.getSyncCalls(), 1);

  await harness.service.addRule({
    blockURL: 'work.example',
    redirectURL: '',
    category: 'work',
    listId: workList.id
  });

  assert.deepEqual(getRuleListIds(harness.getRules()[0]), [workList.id]);
});

test('cannot create more than seven Rule Lists total', async () => {
  const initialRuleLists = [{ id: 'general', name: 'General', disabledCategories: [] }];
  for (let index = 1; index <= 6; index++) {
    initialRuleLists.push({ id: `list-${index}`, name: `List ${index}`, disabledCategories: [] });
  }
  const harness = createHarness({ initialRuleLists });

  await assert.rejects(
    harness.service.createRuleList({ name: 'Too many' }),
    error => error.code === 'rule_list_limit_reached'
  );
  assert.equal(harness.getRuleLists().length, 7);
});

test('non-Pro callers cannot create a custom rule list or assign one through direct intents', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false }
    ],
    access: { isPro: false, isLegacyUser: false }
  });

  await assert.rejects(
    harness.service.createRuleList({ name: 'Study' }),
    error => error.code === 'pro_required'
  );

  await assert.rejects(
    harness.service.addRule({ blockURL: 'work.example', redirectURL: '', listId: 'list-1' }),
    error => error.code === 'pro_required'
  );
});

test('Rule List names are normalized and remain unique case-insensitively', async () => {
  const harness = createHarness();
  const created = await harness.service.createRuleList({ name: '  Deep   Work  ' });

  assert.equal(created.list.name, 'Deep Work');

  await assert.rejects(
    harness.service.createRuleList({ name: 'deep work' }),
    error => error.code === 'rule_list_name_exists'
  );

  await assert.rejects(
    harness.service.createRuleList({ name: ' '.repeat(4) }),
    error => error.code === 'rule_list_name_invalid'
  );

  await assert.rejects(
    harness.service.createRuleList({ name: 'x'.repeat(41) }),
    error => error.code === 'rule_list_name_invalid'
  );
});

test('activating a Rule List profile preserves rules and synchronizes DNR', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Work', disabledCategories: [] }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'work.example',
      redirectURL: '',
      category: 'work',
      assignments: [{ listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null }],
      disabledByUser: false,
      isWhitelist: false
    }]
  });

  const result = await harness.service.activateRuleList({ listId: 'list-1' });

  assert.equal(result.activeRuleListId, 'list-1');
  assert.equal(harness.getActiveRuleListId(), 'list-1');
  assert.equal(harness.getRules()[0].blockURL, 'work.example');
  assert.equal(harness.getSyncCalls(), 1);
});

test('deleting a custom list atomically moves its rules to General', async () => {
  const harness = createHarness();
  const created = await harness.service.createRuleList({ name: 'Study' });
  await harness.service.addRule({
    blockURL: 'study.example',
    redirectURL: '',
    category: 'work',
    listId: created.list.id
  });

  const result = await harness.service.deleteRuleList({ listId: created.list.id });

  assert.equal(result.ruleLists.length, 1);
  assert.equal(result.ruleLists[0].id, 'general');
  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['general']);
});

test('General cannot be renamed or deleted', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.renameRuleList({ listId: 'general', name: 'Other' }),
    error => error.code === 'rule_list_locked'
  );
  await assert.rejects(
    harness.service.deleteRuleList({ listId: 'general' }),
    error => error.code === 'rule_list_locked'
  );
});

test('rule import restores custom list definitions and assignments together', async () => {
  const harness = createHarness();

  const result = await harness.service.replaceAll({
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: ['news'] },
      { id: 'list-3', name: 'Study', disabledCategories: ['social'] }
    ],
    activeRuleListId: 'list-3',
    rules: [{
      blockURL: 'study.example',
      redirectURL: '',
      category: 'work',
      listId: 'list-3'
    }]
  });

  assert.equal(result.ruleLists[1].name, 'Study');
  assert.deepEqual(harness.getRuleLists()[1].disabledCategories, ['social']);
  assert.equal(harness.getActiveRuleListId(), 'list-3');
  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['list-3']);
});

test('Daily limit rules are Pro-only and persist a normalized blocking mode', async () => {
  const freeHarness = createHarness({ access: { isPro: false, isLegacyUser: false } });
  await assert.rejects(
    freeHarness.service.addRule({
      blockURL: 'youtube.com',
      redirectURL: '',
      category: 'social',
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 30 }
    }),
    error => error.code === 'pro_required'
  );

  const proHarness = createHarness();
  await proHarness.service.addRule({
    blockURL: 'youtube.com',
    redirectURL: '',
    category: 'social',
    blockingMode: 'daily_limit',
    dailyLimit: { minutes: 30 }
  });

  const rule = proHarness.getRules()[0];
  const assignment = getRuleAssignment(rule, 'general');
  assert.equal(assignment.blockingMode, 'daily_limit');
  assert.deepEqual(assignment.dailyLimit, { minutes: 30 });
  assert.equal(assignment.schedule, null);
  assert.equal('blockingMode' in rule, false);
  assert.equal('dailyLimit' in rule, false);
});

test('import preserves Daily limit configuration without importing usage history', async () => {
  const harness = createHarness();
  await harness.service.replaceAll({
    rules: [{
      blockURL: 'video.example',
      redirectURL: '',
      category: 'social',
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 45 },
      listId: 'general'
    }]
  });

  assert.deepEqual(
    harness.getRules()[0],
    {
      id: 1,
      blockURL: 'video.example',
      redirectURL: '',
      category: 'social',
      assignments: [{
        listId: 'general',
        disabledByUser: false,
        blockingMode: 'daily_limit',
        schedule: null,
        dailyLimit: { minutes: 45 }
      }],
      isWhitelist: false
    }
  );
});

test('toggling General changes only its assignment and preserves enabled Study Daily Limit state', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'general',
    initialRules: [{
      id: 1,
      blockURL: 'yout',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [
        { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        { listId: 'study', disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 1 } }
      ]
    }]
  });

  const result = await harness.service.toggleRule({ ruleId: 1, listId: 'general' });
  const rule = harness.getRules()[0];

  assert.equal(getRuleAssignment(rule, 'general').disabledByUser, true);
  assert.equal(getRuleAssignment(rule, 'study').disabledByUser, false);
  assert.equal(getRuleAssignment(rule, 'study').blockingMode, 'daily_limit');
  assert.equal('disabledByUser' in rule, false);
  assert.equal(result.assignmentListId, 'general');
  assert.equal(result.assignment.disabledByUser, true);
  assert.equal(harness.getSyncCalls(), 1);
  assert.equal(
    isRuleActiveNow(
      rule,
      [],
      false,
      new Date(2026, 7, 17, 3, 0),
      'study',
      { '1:study': 60 }
    ),
    true
  );
});

test('editing assignment behavior without an enabled-state field preserves its disabled state', async () => {
  const harness = createHarness({
    initialRules: [{
      id: 1,
      blockURL: 'example.com',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [{
        listId: 'general',
        disabledByUser: true,
        blockingMode: 'always',
        schedule: null,
        dailyLimit: null
      }]
    }]
  });

  await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'general',
    blockURL: 'example.com',
    redirectURL: '',
    category: 'social',
    assignment: {
      listId: 'general',
      blockingMode: 'daily_limit',
      schedule: null,
      dailyLimit: { minutes: 15 }
    }
  });

  const assignment = getRuleAssignment(harness.getRules()[0], 'general');
  assert.equal(assignment.disabledByUser, true);
  assert.equal(assignment.blockingMode, 'daily_limit');
});

test('adding an existing rule to another custom list adds membership instead of creating a duplicate', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false },
      { id: 'list-2', name: 'Study', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'youtube.com',
      redirectURL: '',
      category: 'social',
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null,
      disabledByUser: false,
      listIds: ['list-1'],
      isWhitelist: false
    }]
  });

  const result = await harness.service.addRule({
    blockURL: 'youtube.com',
    redirectURL: '',
    category: 'social',
    listIds: ['list-2']
  });

  assert.equal(result.membershipAdded, true);
  assert.equal(result.created, false);
  assert.equal(harness.getRules().length, 1);
  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['list-1', 'list-2']);
  assert.equal(harness.getSyncCalls(), 1);
});

test('adding a custom profile assignment preserves the existing General assignment', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Study', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'youtube.com',
      redirectURL: '',
      category: 'social',
      disabledByUser: false,
      listIds: ['general'],
      isWhitelist: false
    }]
  });

  await harness.service.addRule({
    blockURL: 'youtube.com',
    redirectURL: '',
    category: 'social',
    listIds: ['list-1']
  });

  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['general', 'list-1']);
});

test('adding an existing rule to a list it already belongs to still reports a duplicate', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Study', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'youtube.com',
      redirectURL: '',
      category: 'social',
      disabledByUser: false,
      listIds: ['list-1'],
      isWhitelist: false
    }]
  });

  await assert.rejects(
    harness.service.addRule({
      blockURL: 'youtube.com',
      redirectURL: '',
      category: 'social',
      listIds: ['list-1']
    }),
    error => error.code === 'rule_already_exists'
  );
});

test('Rule Pack adds membership to an existing rule without inflating new-rule count', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false },
      { id: 'list-2', name: 'Study', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'amazon.com',
      redirectURL: '',
      category: 'shopping',
      disabledByUser: false,
      listIds: ['list-1'],
      isWhitelist: false
    }]
  });

  const result = await harness.service.addMany({
    packId: 'shopping',
    entryIds: ['amazon'],
    listId: 'list-2'
  });

  assert.equal(result.addedCount, 1);
  assert.equal(result.newRuleCount, 0);
  assert.equal(result.membershipAddedCount, 1);
  assert.equal(result.skippedDuplicates, 0);
  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['list-1', 'list-2']);
  assert.equal(harness.getRules().length, 1);
  assert.equal(harness.getSyncCalls(), 1);
});

test('deleting one shared custom list preserves the remaining memberships', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false },
      { id: 'list-2', name: 'Study', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'youtube.com',
      redirectURL: '',
      category: 'social',
      disabledByUser: false,
      listIds: ['list-1', 'list-2'],
      isWhitelist: false
    }]
  });

  await harness.service.deleteRuleList({ listId: 'list-2' });
  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['list-1']);

  await harness.service.deleteRuleList({ listId: 'list-1' });
  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['general']);
});


test('the same target can keep different schedules in Work and Study assignments', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false },
      { id: 'list-2', name: 'Study', disabled: false }
    ]
  });

  await harness.service.addRule({
    blockURL: 'youtube.com',
    redirectURL: '',
    category: 'social',
    assignment: {
      listId: 'list-1',
      blockingMode: 'schedule',
      schedule: { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' }
    }
  });

  await harness.service.addRule({
    blockURL: 'youtube.com',
    redirectURL: '',
    category: 'social',
    assignment: {
      listId: 'list-2',
      blockingMode: 'schedule',
      schedule: { days: [1, 3, 5], startTime: '19:00', endTime: '22:00' }
    }
  });

  const [rule] = harness.getRules();
  assert.equal(harness.getRules().length, 1);
  assert.deepEqual(getRuleListIds(rule), ['list-1', 'list-2']);
  assert.deepEqual(getRuleAssignment(rule, 'list-1').schedule.periods, [
    { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' }
  ]);
  assert.deepEqual(getRuleAssignment(rule, 'list-2').schedule.periods, [
    { days: [1, 3, 5], startTime: '19:00', endTime: '22:00' }
  ]);
});

test('editing one assignment does not change another assignment on the same target', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false },
      { id: 'list-2', name: 'Study', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'youtube.com',
      redirectURL: '',
      category: 'social',
      disabledByUser: false,
      isWhitelist: false,
      assignments: [
        { listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null },
        { listId: 'list-2', blockingMode: 'always', schedule: null, dailyLimit: null }
      ]
    }]
  });

  await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'list-2',
    blockURL: 'youtube.com',
    redirectURL: '',
    category: 'social',
    assignment: {
      listId: 'list-2',
      blockingMode: 'schedule',
      schedule: { days: [2], startTime: '18:00', endTime: '20:00' }
    }
  });

  const rule = harness.getRules()[0];
  assert.equal(getRuleAssignment(rule, 'list-1').blockingMode, 'always');
  assert.equal(getRuleAssignment(rule, 'list-1').schedule, null);
  assert.equal(getRuleAssignment(rule, 'list-2').blockingMode, 'schedule');
  assert.deepEqual(getRuleAssignment(rule, 'list-2').schedule.periods, [
    { days: [2], startTime: '18:00', endTime: '20:00' }
  ]);
});

test('adding a different target variant to another list preserves both target identities', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false },
      { id: 'list-2', name: 'Study', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'youtube.com',
      redirectURL: 'https://example.com/focus',
      category: 'social',
      disabledByUser: false,
      isWhitelist: false,
      assignments: [
        { listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null }
      ]
    }]
  });

  await harness.service.addRule({
    blockURL: 'youtube.com',
    redirectURL: '',
    category: 'work',
    assignment: {
      listId: 'list-2',
      blockingMode: 'schedule',
      schedule: { days: [2], startTime: '18:00', endTime: '20:00' }
    }
  });

  const [rule] = harness.getRules();
  assert.equal(harness.getRules().length, 2);
  const original = harness.getRules().find(item => item.id === 1);
  const variant = harness.getRules().find(item => item.id !== 1);
  assert.equal(original.redirectURL, 'https://example.com/focus');
  assert.equal(original.category, 'social');
  assert.deepEqual(getRuleListIds(original), ['list-1']);
  assert.equal(variant.redirectURL, '');
  assert.equal(variant.category, 'work');
  assert.deepEqual(getRuleListIds(variant), ['list-2']);
  assert.equal(getRuleAssignment(variant, 'list-2').blockingMode, 'schedule');
});

test('Free users can toggle an existing General rule', async () => {
  const harness = createHarness({
    initialRules: [{
      id: 1,
      blockURL: 'toggle-free.example',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [
        { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }
      ]
    }],
    access: { isPro: false, isLegacyUser: false }
  });

  await harness.service.toggleRule({ ruleId: 1, listId: 'general' });
  assert.equal(getRuleAssignment(harness.getRules()[0], 'general').disabledByUser, true);

  await harness.service.toggleRule({ ruleId: 1, listId: 'general' });
  assert.equal(getRuleAssignment(harness.getRules()[0], 'general').disabledByUser, false);
  assert.equal(harness.getSyncCalls(), 2);
});

test('Free users can delete at the rule limit and add a replacement', async () => {
  const initialRules = Array.from({ length: MAX_RULES_LIMIT }, (_, index) => ({
    id: index + 1,
    blockURL: `free-${index + 1}.example`,
    redirectURL: '',
    category: 'social',
    isWhitelist: false,
    assignments: [
      { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }
    ]
  }));
  const harness = createHarness({
    initialRules,
    access: { isPro: false, isLegacyUser: false }
  });

  await harness.service.removeAssignment({ ruleId: 4, listId: 'general' });
  await harness.service.addRule({ blockURL: 'replacement.example', redirectURL: '' });

  assert.equal(harness.getRules().length, MAX_RULES_LIMIT);
  assert.equal(harness.getRules().some(rule => rule.blockURL === 'free-4.example'), false);
  assert.equal(harness.getRules().some(rule => rule.blockURL === 'replacement.example'), true);
  assert.equal(harness.getSyncCalls(), 2);
});

test('Free users can delete the last General assignment from an existing blocking rule', async () => {
  const harness = createHarness({
    initialRules: [{
      id: 1,
      blockURL: 'legacy-free.example',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [
        { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }
      ]
    }],
    access: { isPro: false, isLegacyUser: false }
  });

  const result = await harness.service.removeAssignment({ ruleId: 1, listId: 'general' });

  assert.deepEqual(harness.getRules(), []);
  assert.equal(result.targetDeleted, true);
  assert.equal(result.removedAssignmentListId, 'general');
  assert.equal(harness.getSyncCalls(), 1);
});

test('Free users can remove an existing custom-list assignment without gaining Pro access', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Old Pro list', disabledCategories: [] }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'retained.example',
      redirectURL: '',
      category: 'work',
      isWhitelist: false,
      assignments: [
        { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        { listId: 'list-1', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }
      ]
    }],
    access: { isPro: false, isLegacyUser: false }
  });

  const result = await harness.service.removeAssignment({ ruleId: 1, listId: 'list-1' });
  const rule = harness.getRules()[0];

  assert.deepEqual(getRuleListIds(rule), ['general']);
  assert.equal(result.targetDeleted, false);
  assert.equal(result.removedAssignmentListId, 'list-1');
  assert.equal(harness.getSyncCalls(), 1);
});

test('removing one assignment preserves other profiles and removing the last one deletes the target', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false },
      { id: 'list-2', name: 'Study', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'youtube.com',
      redirectURL: '',
      category: 'social',
      disabledByUser: false,
      isWhitelist: false,
      assignments: [
        { listId: 'list-1', blockingMode: 'always', schedule: null, dailyLimit: null },
        {
          listId: 'list-2',
          blockingMode: 'schedule',
          schedule: { days: [2], startTime: '18:00', endTime: '20:00' },
          dailyLimit: null
        }
      ]
    }]
  });

  await harness.service.removeAssignment({ ruleId: 1, listId: 'list-2' });
  let rule = harness.getRules()[0];
  assert.deepEqual(getRuleListIds(rule), ['list-1']);
  assert.equal(getRuleAssignment(rule, 'list-1').blockingMode, 'always');

  const result = await harness.service.removeAssignment({ ruleId: 1, listId: 'list-1' });
  assert.deepEqual(harness.getRules(), []);
  assert.equal(result.targetDeleted, true);
});

test('adding the same block URL with a different redirect in another profile creates a distinct target', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Study', disabled: false },
      { id: 'list-2', name: 'Ext', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'yout',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [
        { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        { listId: 'list-1', disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 1 } }
      ]
    }]
  });

  const result = await harness.service.addRule({
    blockURL: 'yout',
    redirectURL: 'https://example.com/focus',
    category: 'social',
    assignment: {
      listId: 'list-2',
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    }
  });

  assert.equal(result.created, true);
  assert.equal(result.assignmentAdded, false);
  assert.equal(harness.getRules().length, 2);

  const original = harness.getRules().find(rule => rule.id === 1);
  const redirected = harness.getRules().find(rule => rule.id !== 1);
  assert.equal(original.redirectURL, '');
  assert.deepEqual(getRuleListIds(original), ['general', 'list-1']);
  assert.equal(redirected.blockURL, 'yout');
  assert.equal(redirected.redirectURL, 'https://example.com/focus');
  assert.deepEqual(getRuleListIds(redirected), ['list-2']);
});

test('one profile cannot contain two target variants for the same block URL', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-2', name: 'Ext', disabled: false }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'yout',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [
        { listId: 'list-2', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }
      ]
    }]
  });

  await assert.rejects(
    harness.service.addRule({
      blockURL: 'yout',
      redirectURL: 'https://example.com/focus',
      category: 'social',
      assignment: { listId: 'list-2', blockingMode: 'always', schedule: null, dailyLimit: null }
    }),
    error => error.code === 'rule_already_exists'
  );
});

test('editing target fields in one shared profile splits the target and preserves the other profiles', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] },
      { id: 'list-2', name: 'Ext', disabledCategories: [] }
    ],
    initialRules: [{
      id: 1,
      blockURL: 'yout',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [
        { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        { listId: 'list-1', disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 1 } },
        { listId: 'list-2', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }
      ]
    }]
  });

  const result = await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'list-2',
    blockURL: 'yout',
    redirectURL: 'https://example.com/focus',
    category: 'social',
    assignment: {
      listId: 'list-2',
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    }
  });

  assert.equal(result.targetSplit, true);
  assert.equal(harness.getRules().length, 2);
  const original = harness.getRules().find(rule => rule.id === 1);
  const split = harness.getRules().find(rule => rule.id !== 1);
  assert.equal(original.redirectURL, '');
  assert.deepEqual(getRuleListIds(original), ['general', 'list-1']);
  assert.equal(split.redirectURL, 'https://example.com/focus');
  assert.deepEqual(getRuleListIds(split), ['list-2']);
  assert.deepEqual(harness.getUsageRemaps(), [{
    oldRuleId: 1,
    oldListId: 'list-2',
    newRuleId: split.id,
    newListId: 'list-2'
  }]);
});

test('import allows same block URL target variants only when their profile assignments are disjoint', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] },
      { id: 'list-2', name: 'Ext', disabledCategories: [] }
    ]
  });

  const result = await harness.service.replaceAll({
    ruleLists: harness.getRuleLists(),
    activeRuleListId: 'list-2',
    rules: [
      {
        blockURL: 'yout',
        redirectURL: '',
        category: 'social',
        isWhitelist: false,
        assignments: [
          { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
          { listId: 'list-1', disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 1 } }
        ]
      },
      {
        blockURL: 'yout',
        redirectURL: 'https://example.com/focus',
        category: 'social',
        isWhitelist: false,
        assignments: [
          { listId: 'list-2', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }
        ]
      }
    ]
  });

  assert.equal(result.rules.length, 2);
  assert.equal(harness.getRules().length, 2);
});

test('import rejects two target variants for the same block URL in one profile', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Ext', disabledCategories: [] }
    ]
  });

  await assert.rejects(
    harness.service.replaceAll({
      ruleLists: harness.getRuleLists(),
      activeRuleListId: 'list-1',
      rules: [
        {
          blockURL: 'yout',
          redirectURL: '',
          category: 'social',
          isWhitelist: false,
          assignments: [{ listId: 'list-1', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }]
        },
        {
          blockURL: 'yout',
          redirectURL: 'https://example.com/focus',
          category: 'social',
          isWhitelist: false,
          assignments: [{ listId: 'list-1', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }]
        }
      ]
    }),
    error => error.code === 'rule_already_exists'
  );
});

test('deleting a profile does not move a conflicting target variant into General', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Ext', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'list-1',
    initialRules: [
      {
        id: 1,
        blockURL: 'yout',
        redirectURL: '',
        category: 'social',
        isWhitelist: false,
        assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }]
      },
      {
        id: 2,
        blockURL: 'yout',
        redirectURL: 'https://example.com/focus',
        category: 'social',
        isWhitelist: false,
        assignments: [{ listId: 'list-1', disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 1 } }]
      }
    ]
  });

  const result = await harness.service.deleteRuleList({ listId: 'list-1' });
  assert.equal(result.removedConflictingTargets, 1);
  assert.equal(result.activeRuleListId, 'general');
  assert.equal(harness.getRules().length, 1);
  assert.equal(harness.getRules()[0].id, 1);
  assert.deepEqual(harness.getUsageRemaps(), []);
});

test('deleting a profile remaps Daily Limit usage when its sole target moves to General', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'list-1',
    initialRules: [{
      id: 7,
      blockURL: 'reddit.com',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [{ listId: 'list-1', disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 30 } }]
    }]
  });

  await harness.service.deleteRuleList({ listId: 'list-1' });
  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['general']);
  assert.deepEqual(harness.getUsageRemaps(), [{
    oldRuleId: 7,
    oldListId: 'list-1',
    newRuleId: 7,
    newListId: 'general'
  }]);
  assert.equal(harness.getUsageRemapBatches().length, 1);
});

test('deleting a profile with ordinary rules never remaps Daily Limit usage', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'study',
    initialRules: Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      blockURL: 'site' + (index + 1) + '.example',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [{
        listId: 'study',
        disabledByUser: false,
        blockingMode: 'always',
        schedule: null,
        dailyLimit: null
      }]
    }))
  });

  await harness.service.deleteRuleList({ listId: 'study' });

  assert.equal(harness.getRules().length, 100);
  assert.equal(harness.savedStates.length, 1);
  assert.deepEqual(harness.getUsageRemaps(), []);
  assert.deepEqual(harness.getUsageRemapBatches(), []);
});

test('deleting a mixed profile batches only Daily Limit assignment remaps', async () => {
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    initialActiveRuleListId: 'study',
    initialRules: Array.from({ length: 30 }, (_, index) => {
      const dailyLimit = index % 3 === 0;
      return {
        id: index + 1,
        blockURL: 'site' + (index + 1) + '.example',
        redirectURL: '',
        category: 'social',
        isWhitelist: false,
        assignments: [{
          listId: 'study',
          disabledByUser: false,
          blockingMode: dailyLimit ? 'daily_limit' : 'always',
          schedule: null,
          dailyLimit: dailyLimit ? { minutes: 30 } : null
        }]
      };
    })
  });

  await harness.service.deleteRuleList({ listId: 'study' });

  assert.equal(harness.savedStates.length, 1);
  assert.equal(harness.getUsageRemapBatches().length, 1);
  assert.equal(harness.getUsageRemapBatches()[0].length, 10);
  assert.deepEqual(
    harness.getUsageRemaps().map(remap => remap.oldRuleId),
    [1, 4, 7, 10, 13, 16, 19, 22, 25, 28]
  );
});

test('Free rule creation cannot introduce a paid scheduled General assignment', async () => {
  const harness = createHarness({ access: { isPro: false, isLegacyUser: false } });

  await assert.rejects(
    harness.service.addRule({
      blockURL: 'night.example',
      assignment: {
        listId: 'general',
        blockingMode: 'schedule',
        schedule: { days: [1], startTime: '22:00', endTime: '06:00' }
      }
    }),
    error => error.code === 'pro_required'
  );

  assert.deepEqual(harness.getRules(), []);
  assert.equal(harness.savedStates.length, 0);
  assert.equal(harness.getSyncCalls(), 0);
});

test('Free rule editing cannot convert a basic General assignment into a paid schedule', async () => {
  const original = makeCapacityRule(1);
  const harness = createHarness({
    initialRules: [original],
    access: { isPro: false, isLegacyUser: false }
  });

  await assert.rejects(
    harness.service.updateRule({
      ruleId: 1,
      assignmentListId: 'general',
      assignment: {
        listId: 'general',
        blockingMode: 'schedule',
        schedule: { days: [1], startTime: '22:00', endTime: '06:00' }
      }
    }),
    error => error.code === 'pro_required'
  );

  assert.deepEqual(harness.getRules(), [original]);
  assert.equal(harness.savedStates.length, 0);
});

test('former Pro users can edit a target while preserving their existing overnight schedule', async () => {
  const original = makeScheduledCapacityRule();
  const harness = createHarness({
    initialRules: [original],
    access: { isPro: false, isLegacyUser: false }
  });

  const result = await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'general',
    blockURL: 'renamed-night.example',
    assignment: {
      listId: 'general',
      disabledByUser: true,
      blockingMode: 'schedule',
      schedule: {
        version: 2,
        periods: [{ days: [1], startTime: '22:00', endTime: '06:00' }]
      }
    }
  });

  assert.equal(result.rule.blockURL, 'renamed-night.example');
  assert.equal(result.rule.assignments[0].disabledByUser, true);
  assert.deepEqual(result.rule.assignments[0].schedule.periods, [{
    days: [1], startTime: '22:00', endTime: '06:00'
  }]);
  assert.equal(harness.getSyncCalls(), 1);
});

test('former Pro target edits without an explicit assignment preserve the existing schedule', async () => {
  const harness = createHarness({
    initialRules: [makeScheduledCapacityRule()],
    access: { isPro: false, isLegacyUser: false }
  });

  const result = await harness.service.updateRule({
    ruleId: 1,
    blockURL: 'renamed-without-assignment.example'
  });

  assert.equal(result.rule.blockURL, 'renamed-without-assignment.example');
  assert.equal(result.rule.assignments[0].blockingMode, 'schedule');
  assert.equal(result.rule.assignments[0].schedule.periods[0].endTime, '06:00');
});

test('former Pro users cannot change the times or selected days of a preserved schedule', async () => {
  for (const schedule of [
    { days: [1], startTime: '21:00', endTime: '06:00' },
    { days: [1], startTime: '22:00', endTime: '07:00' },
    { days: [1, 2], startTime: '22:00', endTime: '06:00' }
  ]) {
    const original = makeScheduledCapacityRule();
    const harness = createHarness({
      initialRules: [original],
      access: { isPro: false, isLegacyUser: false }
    });

    await assert.rejects(
      harness.service.updateRule({
        ruleId: 1,
        assignmentListId: 'general',
        assignment: { listId: 'general', blockingMode: 'schedule', schedule }
      }),
      error => error.code === 'pro_required'
    );
    assert.deepEqual(harness.getRules(), [original]);
    assert.equal(harness.savedStates.length, 0);
  }
});

test('former Pro users can remove a paid schedule and keep their basic blocking rule', async () => {
  const harness = createHarness({
    initialRules: [makeScheduledCapacityRule()],
    access: { isPro: false, isLegacyUser: false }
  });

  const cleaned = await harness.service.updateRule({
    ruleId: 1,
    assignmentListId: 'general',
    assignment: {
      listId: 'general',
      blockingMode: 'always',
      schedule: null
    }
  });

  assert.equal(cleaned.rule.assignments[0].blockingMode, 'always');
  assert.equal(cleaned.rule.assignments[0].schedule, null);
  await assert.rejects(
    harness.service.updateRule({
      ruleId: 1,
      assignmentListId: 'general',
      assignment: {
        listId: 'general',
        blockingMode: 'schedule',
        schedule: { days: [1], startTime: '22:00', endTime: '06:00' }
      }
    }),
    error => error.code === 'pro_required'
  );
  assert.equal(harness.getRules()[0].assignments[0].blockingMode, 'always');
});

test('Free users can toggle and delete an inherited scheduled General assignment', async () => {
  const harness = createHarness({
    initialRules: [makeScheduledCapacityRule()],
    access: { isPro: false, isLegacyUser: false }
  });

  const toggled = await harness.service.toggleRule({ ruleId: 1, listId: 'general' });
  assert.equal(toggled.rule.assignments[0].disabledByUser, true);
  assert.equal(toggled.rule.assignments[0].blockingMode, 'schedule');

  const removed = await harness.service.removeAssignment({ ruleId: 1, listId: 'general' });
  assert.equal(removed.targetDeleted, true);
  assert.deepEqual(harness.getRules(), []);
  assert.equal(harness.getSyncCalls(), 2);
});

test('Free users can remove an inherited overnight assignment from a preserved custom list', async () => {
  const rule = makeScheduledCapacityRule();
  rule.assignments.push({
    listId: 'list-1',
    disabledByUser: false,
    blockingMode: 'schedule',
    schedule: { days: [5], startTime: '23:00', endTime: '04:00' },
    dailyLimit: null
  });
  const harness = createHarness({
    initialRuleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ],
    initialRules: [rule],
    access: { isPro: false, isLegacyUser: false }
  });

  const result = await harness.service.removeAssignment({ ruleId: 1, listId: 'list-1' });

  assert.equal(result.targetDeleted, false);
  assert.deepEqual(getRuleListIds(harness.getRules()[0]), ['general']);
  assert.equal(getRuleAssignment(harness.getRules()[0], 'general').blockingMode, 'schedule');
});

test('both Pro and genuine legacy access can create and change overnight schedules', async () => {
  for (const access of [
    { isPro: true, isLegacyUser: false },
    { isPro: false, isLegacyUser: true }
  ]) {
    const harness = createHarness({ access });
    const created = await harness.service.addRule({
      blockURL: 'paid-night.example',
      assignment: {
        listId: 'general',
        blockingMode: 'schedule',
        schedule: { days: [1], startTime: '22:00', endTime: '06:00' }
      }
    });
    const updated = await harness.service.updateRule({
      ruleId: created.rule.id,
      assignmentListId: 'general',
      assignment: {
        listId: 'general',
        blockingMode: 'schedule',
        schedule: { days: [5], startTime: '23:00', endTime: '07:30' }
      }
    });

    assert.deepEqual(updated.rule.assignments[0].schedule.periods, [{
      days: [5], startTime: '23:00', endTime: '07:30'
    }]);
    assert.equal(harness.getSyncCalls(), 2);
  }
});

test('shared Rule Pack overnight schedules apply independently to every added target', async () => {
  const harness = createHarness();

  const result = await harness.service.addMany({
    packId: 'social',
    entryIds: ['facebook', 'instagram'],
    schedule: { days: [0, 5], startTime: '22:00', endTime: '06:00' }
  });

  assert.equal(result.addedCount, 2);
  assert.equal(result.scheduleApplied, true);
  for (const rule of harness.getRules()) {
    assert.equal(rule.assignments[0].blockingMode, 'schedule');
    assert.deepEqual(rule.assignments[0].schedule.periods, [{
      days: [0, 5], startTime: '22:00', endTime: '06:00'
    }]);
  }
  assert.equal(harness.savedStates.length, 1);
});

test('import preserves overnight schedule assignments and their selected start weekdays', async () => {
  const harness = createHarness();

  const result = await harness.service.replaceAll({
    rules: [{
      blockURL: 'imported-night.example',
      redirectURL: '',
      category: 'social',
      assignments: [{
        listId: 'general',
        blockingMode: 'schedule',
        schedule: { days: [0, 6], startTime: '23:30', endTime: '07:00' }
      }]
    }]
  });

  assert.deepEqual(result.rules[0].assignments[0].schedule.periods, [{
    days: [0, 6], startTime: '23:30', endTime: '07:00'
  }]);
  assert.equal(harness.savedStates.length, 1);
});

test('Rule List mutation results distinguish creation from a changed activation', async () => {
  const harness = createHarness();

  const created = await harness.service.createRuleList({ name: 'Work' });
  assert.equal(created.ruleListCreated, true);
  assert.equal(created.activeRuleListId, created.list.id);

  const repeated = await harness.service.activateRuleList({ listId: created.list.id });
  assert.equal(repeated.activeRuleListChanged, false);

  const changed = await harness.service.activateRuleList({ listId: 'general' });
  assert.equal(changed.activeRuleListChanged, true);
  assert.equal(changed.activeRuleListId, 'general');
});

test('Daily Limit mutation results ignore unrelated edits and removals', async () => {
  const harness = createHarness();

  const added = await harness.service.addRule({
    blockURL: 'video.example',
    redirectURL: '',
    category: 'social',
    blockingMode: 'daily_limit',
    dailyLimit: { minutes: 20 }
  });
  assert.equal(added.dailyLimitConfigured, true);

  const ordinaryEdit = await harness.service.updateRule({
    ruleId: added.rule.id,
    assignmentListId: 'general',
    blockURL: 'video.example',
    redirectURL: '',
    category: 'entertainment',
    assignment: {
      listId: 'general',
      blockingMode: 'daily_limit',
      schedule: null,
      dailyLimit: { minutes: 20 }
    }
  });
  assert.equal(ordinaryEdit.dailyLimitConfigured, false);

  const changedLimit = await harness.service.updateRule({
    ruleId: added.rule.id,
    assignmentListId: 'general',
    blockURL: 'video.example',
    redirectURL: '',
    category: 'entertainment',
    assignment: {
      listId: 'general',
      blockingMode: 'daily_limit',
      schedule: null,
      dailyLimit: { minutes: 35 }
    }
  });
  assert.equal(changedLimit.dailyLimitConfigured, true);

  const removedLimit = await harness.service.updateRule({
    ruleId: added.rule.id,
    assignmentListId: 'general',
    blockURL: 'video.example',
    redirectURL: '',
    category: 'entertainment',
    assignment: {
      listId: 'general',
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    }
  });
  assert.equal(removedLimit.dailyLimitConfigured, false);

  const ordinaryRule = await harness.service.addRule({
    blockURL: 'ordinary.example',
    redirectURL: '',
    category: 'social'
  });
  assert.equal(ordinaryRule.dailyLimitConfigured, false);
});
