import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRulesMutationService,
  serializeRulesMutationError
} from '../rules/rulesMutationService.js';
import { resolveRulePackEntries } from '../rules/rulePacks.js';
import { getRuleAssignment, getRuleListIds } from '../rules/ruleAssignments.js';
import { isRuleActiveNow } from '../rules/ruleActivation.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness({
  initialRules = [],
  initialRuleLists = [{ id: 'general', name: 'General', disabledCategories: [] }],
  initialActiveRuleListId = 'general',
  access = { isPro: true, isLegacyUser: false },
  syncResult = { success: true },
  validation = null
} = {}) {
  let rules = clone(initialRules);
  let ruleLists = clone(initialRuleLists);
  let activeRuleListId = initialActiveRuleListId;
  let settings = { disabledCategories: [], enablePassword: false, passwordHash: null };
  const savedStates = [];
  const notifications = [];
  let syncCalls = 0;

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
      }
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return [];
      }
    },
    getAccess: async () => access,
    getSettings: async () => clone(settings),
    saveSettings: async (nextSettings) => {
      settings = clone(nextSettings);
    },
    saveRulesAndLists: async (nextRules, nextLists, nextActiveRuleListId = null) => {
      rules = clone(nextRules);
      ruleLists = clone(nextLists);
      if (nextActiveRuleListId) activeRuleListId = nextActiveRuleListId;
      savedStates.push(clone(nextRules));
    },
    maxRulesLimit: 10,
    resolveRulePackEntries,
    notifyRulesChanged(nextRules, extra) {
      notifications.push({ rules: clone(nextRules), extra: clone(extra) });
    },
    logger: {
      log() {},
      info() {},
      warn() {},
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
    getSyncCalls: () => syncCalls
  };
}

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
  const initialRules = Array.from({ length: 10 }, (_, index) => ({
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

  assert.equal(harness.getRules().length, 10);
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
        periods: [{ days: [], startTime: '18:00', endTime: '09:00' }]
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

test('adding an existing target to another list preserves target-level redirect and category', async () => {
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
  assert.equal(harness.getRules().length, 1);
  assert.equal(rule.redirectURL, 'https://example.com/focus');
  assert.equal(rule.category, 'social');
  assert.deepEqual(getRuleListIds(rule), ['list-1', 'list-2']);
  assert.equal(getRuleAssignment(rule, 'list-2').blockingMode, 'schedule');
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
