import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRulesMutationService,
  serializeRulesMutationError
} from '../rules/rulesMutationService.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness({
  initialRules = [],
  access = { isPro: true, isLegacyUser: false },
  syncResult = { success: true },
  validation = null
} = {}) {
  let rules = clone(initialRules);
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
    checkConflict() {
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
    maxRulesLimit: 10,
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
