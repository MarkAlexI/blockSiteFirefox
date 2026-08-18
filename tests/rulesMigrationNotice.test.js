import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RULES_MIGRATION_NOTICE_VERSION_KEY,
  claimRulesMigrationNotice
} from '../rules/rulesMigrationNotice.js';

function createStorage(initial = {}) {
  const state = structuredClone(initial);
  const setCalls = [];
  return {
    state,
    setCalls,
    async get(key) {
      return { [key]: structuredClone(state[key]) };
    },
    async set(values) {
      Object.assign(state, structuredClone(values));
      setCalls.push(structuredClone(values));
    }
  };
}

test('compatibility notice is claimed once for an actual extension update migration', async () => {
  const storageArea = createStorage();
  const input = {
    details: { reason: 'update' },
    migrationResult: { userVisibleMigration: true },
    storageArea,
    extensionVersion: '5.0.0'
  };

  assert.equal(await claimRulesMigrationNotice(input), true);
  assert.equal(await claimRulesMigrationNotice(input), false);
  assert.equal(storageArea.state[RULES_MIGRATION_NOTICE_VERSION_KEY], '5.0.0');
  assert.equal(storageArea.setCalls.length, 1);
});

test('startup and internal-only migrations never claim a compatibility notice', async () => {
  const storageArea = createStorage();

  assert.equal(await claimRulesMigrationNotice({
    details: { reason: 'startup' },
    migrationResult: { userVisibleMigration: true },
    storageArea,
    extensionVersion: '5.0.0'
  }), false);

  assert.equal(await claimRulesMigrationNotice({
    details: { reason: 'update' },
    migrationResult: { userVisibleMigration: false },
    storageArea,
    extensionVersion: '5.0.0'
  }), false);

  assert.equal(storageArea.setCalls.length, 0);
});
