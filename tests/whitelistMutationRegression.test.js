import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesManager } from '../rules/rulesManager.js';
import { createRulesMutationService } from '../rules/rulesMutationService.js';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';

const general = { id: 'general', name: 'General', disabledCategories: [] };
const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
const allow = (blockURL, id = 1) => ({ id, blockURL, redirectURL: '', category: 'whitelist',
  isWhitelist: true, assignments: [structuredClone(assignment)] });
const block = (blockURL, id = 2) => ({ id, blockURL, redirectURL: '', category: 'social',
  isWhitelist: false, assignments: [structuredClone(assignment)] });

// Run production validation, conflict checking, identity and mutation logic.
// Only storage, browser capacity/synchronization and access are local boundaries.
function fixture(initialRules = [], packEntries = []) {
  let rows = structuredClone(initialRules), settings = {};
  const writes = [], syncs = [], notifications = [];
  const manager = new RulesManager();
  manager.getRules = async () => structuredClone(rows);
  manager.getRulesSnapshot = async () => ({ rules: structuredClone(rows) });
  manager.saveRules = async next => { rows = structuredClone(next); writes.push(structuredClone(rows)); };
  const service = createRulesMutationService({ rulesManager: manager,
    ruleListsManager: { getState: async () => ({ lists: [general], activeRuleListId: 'general' }) },
    declarativeNetRequest: { getDynamicRules: async () => [] },
    dnrSynchronizer: { requestSync: async () => { syncs.push(true); return { success: true }; },
      validateRuleCapacity: async () => ({ withinCapacity: true }) },
    getAccess: async () => ({ isPro: true }), getSettings: async () => settings,
    saveSettings: async value => { settings = value; },
    saveRulesAndLists: async next => { rows = structuredClone(next); writes.push(structuredClone(rows)); },
    maxRulesLimit: 10, notifyRulesChanged: value => notifications.push(value),
    resolveRulePackEntries: () => ({ pack: { category: 'social' }, entries: packEntries, invalidEntryIds: [] }),
    logger: { warn() {}, log() {}, info() {} }
  });
  return { service, rows: () => structuredClone(rows), writes, syncs, notifications };
}

test('adding a blacklist ignores Whitelist text that only occurs in a pasted query', async () => {
  const original = allow('allowed.example');
  const f = fixture([original]);
  await f.service.addRule(block('https://other.test/?next=allowed.example'));
  assert.equal(f.rows().length, 2);
  assert.deepEqual(f.rows()[0], original);
  assert.equal(f.writes.length, 1); assert.equal(f.syncs.length, 1);
});

for (const target of ['www.', 'https://[bad', '*.allowed.example']) {
  test(`an invalid Whitelist add cannot write or synchronize: ${target}`, async () => {
    const original = block('old.test');
    const f = fixture([original]);
    await assert.rejects(f.service.addRule(allow(target)), error => error.code === 'validation_failed');
    assert.deepEqual(f.rows(), [original]);
    assert.equal(f.writes.length, 0); assert.equal(f.syncs.length, 0); assert.equal(f.notifications.length, 0);
  });
}

test('an equivalent Whitelist add is rejected without rewriting the original spelling or ID', async () => {
  const original = allow('HTTPS://www.allowed.example:8080/TEAM/?q=1', 71);
  const f = fixture([original]);
  await assert.rejects(f.service.addRule(allow('http://allowed.example/team/')),
    error => ['redundant_whitelist', 'rule_already_exists'].includes(error.code));
  assert.deepEqual(f.rows(), [original]); assert.equal(f.writes.length, 0); assert.equal(f.syncs.length, 0);
});

test('editing a different Whitelist cannot introduce a canonical duplicate', async () => {
  const original = [allow('https://www.allowed.example/team/', 10), allow('other.test', 20)];
  const f = fixture(original);
  await assert.rejects(f.service.updateRule({ ruleId: 20, blockURL: 'allowed.example:8081/TEAM', isWhitelist: true }),
    error => ['redundant_whitelist', 'rule_already_exists'].includes(error.code));
  assert.deepEqual(f.rows(), original); assert.equal(f.writes.length, 0);
});

test('editing an existing Whitelist alias excludes its own row and preserves its ID', async () => {
  const f = fixture([allow('https://www.allowed.example/TEAM/', 10)]);
  await f.service.updateRule({ ruleId: 10, blockURL: 'allowed.example:8081/team', isWhitelist: true });
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].id, 10);
  assert.equal(isUrlInWhitelist('http://sub.allowed.example:8080/team/project', f.rows()), true);
});

test('invalid legacy Whitelist rows remain editable and can be repaired', async () => {
  const f = fixture([allow('www.', 8)]);
  await assert.rejects(f.service.updateRule({ ruleId: 8, blockURL: 'https://[bad', isWhitelist: true }),
    error => error.code === 'validation_failed');
  assert.equal(f.rows()[0].blockURL, 'www.'); assert.equal(f.writes.length, 0);
  await f.service.updateRule({ ruleId: 8, blockURL: 'allowed.example', isWhitelist: true });
  assert.equal(f.rows()[0].id, 8);
  assert.equal(isUrlInWhitelist('https://allowed.example/', f.rows()), true);
});

for (const whiteFirst of [true, false]) {
  test(`backup replacement accepts disjoint targets in ${whiteFirst ? 'Whitelist-first' : 'blacklist-first'} order`, async () => {
    const f = fixture([block('old.test')]);
    const rows = [allow('allowed.example'), block('https://other.test/?next=allowed.example')];
    await f.service.replaceAll({ rules: whiteFirst ? rows : rows.reverse(), ruleLists: [general] });
    assert.equal(f.rows().length, 2); assert.equal(f.syncs.length, 1);
    assert.equal(isUrlInWhitelist('https://allowed.example/', f.rows().filter(r => r.isWhitelist)), true);
  });

  test(`backup replacement rejects real host/path overlap in ${whiteFirst ? 'Whitelist-first' : 'blacklist-first'} order`, async () => {
    const original = [block('old.test')], f = fixture(original);
    const rows = [allow('allowed.example/team'), block('allowed.example/tea')];
    await assert.rejects(f.service.replaceAll({ rules: whiteFirst ? rows : rows.reverse(), ruleLists: [general] }),
      error => ['conflict_whitelist', 'conflict_blacklist'].includes(error.code));
    assert.deepEqual(f.rows(), original); assert.equal(f.writes.length, 0); assert.equal(f.syncs.length, 0);
  });
}

test('backup replacement rejects canonical Whitelist duplicates atomically', async () => {
  const original = [block('old.test')], f = fixture(original);
  await assert.rejects(f.service.replaceAll({ rules: [allow('https://www.allowed.example/TEAM/'),
    allow('allowed.example:8080/team', 2)], ruleLists: [general] }),
    error => ['redundant_whitelist', 'rule_already_exists'].includes(error.code));
  assert.deepEqual(f.rows(), original); assert.equal(f.writes.length, 0); assert.equal(f.syncs.length, 0);
});

test('an invalid late backup row cannot replace valid saved rules', async () => {
  const original = [allow('allowed.example'), block('old.test')], f = fixture(original);
  await assert.rejects(f.service.replaceAll({ rules: [block('new.test'), allow('www.', 3)], ruleLists: [general] }),
    error => ['validation_failed', 'invalid_import'].includes(error.code));
  assert.deepEqual(f.rows(), original); assert.equal(f.writes.length, 0); assert.equal(f.syncs.length, 0);
});

test('Rule Packs use production conflict checks without rejecting unrelated query text', async () => {
  const f = fixture([allow('allowed.example')], [
    { id: 'unrelated', blockURL: 'https://other.test/?next=allowed.example' },
    { id: 'overlap', blockURL: 'allowed.example/team' }
  ]);
  const result = await f.service.addMany({ packId: 'fixture', entryIds: ['unrelated', 'overlap'] });
  assert.equal(f.rows().length, 2);
  assert.ok(f.rows().some(row => row.blockURL.startsWith('https://other.test/')));
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0].entryId, 'overlap');
  assert.equal(f.syncs.length, 1);
});
