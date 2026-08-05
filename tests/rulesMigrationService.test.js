import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRulesMigrationService,
  migrateRuleSchema
} from '../rules/rulesMigrationService.js';

function clone(value) {
  return structuredClone(value);
}

function createStorageArea(initialState = {}, options = {}) {
  const state = clone(initialState);
  const setCalls = [];
  let getCalls = 0;

  return {
    state,
    setCalls,
    getCalls: () => getCalls,
    async get(keys) {
      getCalls++;
      if (options.failGet) throw new Error('storage get failed');

      if (typeof keys === 'string') {
        return { [keys]: clone(state[keys]) };
      }

      const result = {};
      for (const key of keys) {
        result[key] = clone(state[key]);
      }
      return result;
    },
    async set(values) {
      if (options.failSet) throw new Error('storage set failed');
      Object.assign(state, clone(values));
      setCalls.push(clone(values));
    }
  };
}

function createHarness({ local = {}, sync = {}, localOptions = {} } = {}) {
  const localStorage = createStorageArea(local, localOptions);
  const syncStorage = createStorageArea(sync);
  const savedRules = [];
  const logs = [];

  const rulesManager = {
    async getRules() {
      return clone(localStorage.state.rules || []);
    },
    async saveRules(rules) {
      localStorage.state.rules = clone(rules);
      savedRules.push(clone(rules));
    }
  };

  const service = createRulesMigrationService({
    rulesManager,
    localStorage,
    syncStorage,
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  return {
    service,
    localStorage,
    syncStorage,
    savedRules,
    logs
  };
}

test('schema migration resets all IDs when one ID is invalid and adds defaults', () => {
  const result = migrateRuleSchema([
    { id: 8, blockURL: 'one.example' },
    { id: 'bad', blockURL: 'two.example', isWhitelist: true }
  ]);

  assert.equal(result.migrated, true);
  assert.equal(result.idsReset, true);
  assert.deepEqual(result.rules, [
    {
      id: 1,
      blockURL: 'one.example',
      category: 'uncategorized',
      disabledByUser: false,
      isWhitelist: false
    },
    {
      id: 2,
      blockURL: 'two.example',
      isWhitelist: true,
      category: 'whitelist',
      disabledByUser: false
    }
  ]);
});

test('current schema is returned without a storage rewrite', () => {
  const rules = [{
    id: 1,
    blockURL: 'current.example',
    redirectURL: '',
    category: 'social',
    disabledByUser: false,
    isWhitelist: false
  }];

  const result = migrateRuleSchema(rules);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.rules, rules);
});

test('existing local rules take priority over stale sync rules', async () => {
  const localRule = { id: 5, blockURL: 'local.example' };
  const harness = createHarness({
    local: { rules: [localRule] },
    sync: { rules: [{ id: 1, blockURL: 'stale.example' }] }
  });

  const migrated = await harness.service.migrateToLocalForDevice();

  assert.equal(migrated, false);
  assert.deepEqual(harness.localStorage.state.rules, [localRule]);
  assert.equal(harness.localStorage.state.is_migrated_to_local, true);
  assert.equal(harness.syncStorage.getCalls(), 0);
});

test('sync rules and migration flag are copied in one local storage write', async () => {
  const syncRules = [{ id: 1, blockURL: 'sync.example' }];
  const harness = createHarness({ sync: { rules: syncRules } });

  const migrated = await harness.service.migrateToLocalForDevice();

  assert.equal(migrated, true);
  assert.deepEqual(harness.localStorage.setCalls, [{
    rules: syncRules,
    is_migrated_to_local: true
  }]);
});

test('an existing migration flag skips all migration reads and writes', async () => {
  const harness = createHarness({
    local: {
      rules: [{ id: 1, blockURL: 'existing.example' }],
      is_migrated_to_local: true
    },
    sync: { rules: [{ id: 2, blockURL: 'sync.example' }] }
  });

  const migrated = await harness.service.migrateToLocalForDevice();

  assert.equal(migrated, false);
  assert.equal(harness.localStorage.setCalls.length, 0);
  assert.equal(harness.syncStorage.getCalls(), 0);
});

test('storage failure does not mark migration as complete', async () => {
  const harness = createHarness({
    localOptions: { failGet: true },
    sync: { rules: [{ id: 1, blockURL: 'sync.example' }] }
  });

  const migrated = await harness.service.migrateToLocalForDevice();

  assert.equal(migrated, false);
  assert.equal(harness.localStorage.state.is_migrated_to_local, undefined);
  assert.equal(harness.localStorage.setCalls.length, 0);
});

test('combined migration copies legacy rules and then upgrades their schema', async () => {
  const harness = createHarness({
    sync: {
      rules: [{ blockURL: 'legacy.example' }]
    }
  });

  const result = await harness.service.migrateAll();

  assert.equal(result.migrated, true);
  assert.equal(result.migratedFromSync, true);
  assert.equal(result.schemaMigration.migrated, true);
  assert.deepEqual(harness.localStorage.state.rules, [{
    id: 1,
    blockURL: 'legacy.example',
    category: 'uncategorized',
    disabledByUser: false,
    isWhitelist: false
  }]);
  assert.equal(harness.savedRules.length, 1);
});
