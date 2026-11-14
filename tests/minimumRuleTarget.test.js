import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { RulesManager, getRuleTargetLength } from '../rules/rulesManager.js';
import { createRulesMutationService } from '../rules/rulesMutationService.js';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { doesUrlMatchBlockRule } from '../rules/urlRuleMatcher.js';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';
import { getRulePacks } from '../rules/rulePacks.js';
import { shouldRecordRulesTelemetryError } from '../telemetry/telemetryRuleError.js';

const lists = [{ id: 'general', name: 'General', disabledCategories: [] },
  { id: 'list-1', name: 'Work', disabledCategories: [] }];
const assignment = (listId = 'general') => ({ listId, disabledByUser: false,
  blockingMode: 'always', schedule: null, dailyLimit: null });
const row = (blockURL, isWhitelist = false, id = 41) => ({ id, blockURL, isWhitelist,
  redirectURL: '', category: isWhitelist ? 'whitelist' : 'social', assignments: [assignment()] });
const tooShort = error => error.code === 'validation_failed'
  && error.validationErrors.includes('blockurl_too_short');

// Exercise real validation and mutation logic. Mock only persistence/browser boundaries.
function fixture(initialRules = [], packEntries = []) {
  let rules = structuredClone(initialRules), settings = {};
  const writes = [], syncs = [], remaps = [];
  const manager = new RulesManager();
  manager.getRules = async () => structuredClone(rules);
  manager.getRulesSnapshot = async () => ({ rules: structuredClone(rules) });
  manager.saveRules = async next => { rules = structuredClone(next); writes.push(structuredClone(next)); };
  const service = createRulesMutationService({ rulesManager: manager,
    ruleListsManager: { getState: async () => ({ lists, activeRuleListId: 'general' }) },
    declarativeNetRequest: { getDynamicRules: async () => [] },
    dnrSynchronizer: { requestSync: async () => { syncs.push(true); return { success: true }; },
      validateRuleCapacity: async () => ({ withinCapacity: true }) },
    dailyLimitManager: { remapAssignmentKey: async (...args) => remaps.push(args) },
    getAccess: async () => ({ isPro: true }), getSettings: async () => settings,
    saveSettings: async value => { settings = value; },
    saveRulesAndLists: async next => { rules = structuredClone(next); writes.push(structuredClone(next)); },
    maxRulesLimit: 10, notifyRulesChanged() {},
    resolveRulePackEntries: () => ({ pack: { category: 'social' }, entries: packEntries, invalidEntryIds: [] }),
    logger: { warn() {}, log() {}, info() {} }
  });
  return { service, rows: () => structuredClone(rules), writes, syncs, remaps };
}

for (const isWhitelist of [false, true]) {
  test(`new ${isWhitelist ? 'Whitelist' : 'blacklist'} targets need four actual target characters`, async () => {
    for (const blockURL of ['a', 'ab', 'abc', '  abc  ', 'https://abc/', 'HTTP://www.abc/',
      'abc:8080', 'https://name:password@abc/?long=query#fragment', 'abc///',
      '42', 'https://42', 'é', '%61%62%63']) {
      const original = row('original.example'), f = fixture([original]);
      await assert.rejects(f.service.addRule(row(blockURL, isWhitelist)), tooShort, blockURL);
      assert.deepEqual(f.rows(), [original]);
      assert.equal(f.writes.length, 0); assert.equal(f.syncs.length, 0);
    }
    for (const blockURL of ['news', 'tube', 'yout', 't.co', 'x.io', 'a/bb',
      'HTTPS://www.news/?long=query', 'приклад.укр/шлях']) {
      const f = fixture();
      await f.service.addRule(row(blockURL, isWhitelist));
      assert.equal(f.rows()[0].blockURL, blockURL);
      assert.equal(f.writes.length, 1); assert.equal(f.syncs.length, 1);
    }
  });

  test(`editing a saved short ${isWhitelist ? 'Whitelist' : 'blacklist'} keeps its target usable`, async () => {
    for (const sourceScoped of [false, true]) {
      const original = row('ab', isWhitelist), f = fixture([original]);
      const payload = { ruleId: original.id, blockURL: 'HTTP://www.ab/', category: 'news',
        ...(sourceScoped ? { assignmentListId: 'general', assignment: assignment() } : {}) };
      await f.service.updateRule(payload);
      assert.equal(f.rows()[0].id, original.id);
      assert.equal(f.rows()[0].blockURL, payload.blockURL);
      assert.equal(f.rows().length, 1);
      assert.equal(f.writes.length, 1);
      assert.deepEqual(f.remaps, []);
    }
  });

  test(`editing another target into a new short ${isWhitelist ? 'Whitelist' : 'blacklist'} is rejected`, async () => {
    const original = row('old.example', isWhitelist), f = fixture([original]);
    await assert.rejects(f.service.updateRule({ ruleId: original.id, blockURL: 'abc' }), tooShort);
    assert.deepEqual(f.rows(), [original]); assert.equal(f.writes.length, 0);
    await f.service.updateRule({ ruleId: original.id, blockURL: 'news' });
    assert.equal(f.rows()[0].id, original.id); assert.equal(f.rows()[0].blockURL, 'news');
  });
}

test('operators cannot pad a short new blacklist target', async () => {
  for (const blockURL of ['abc*', 'ab^^', 'abc|', 'ab***^|']) {
    const f = fixture();
    await assert.rejects(f.service.addRule(row(blockURL)), tooShort, blockURL);
    assert.deepEqual(f.writes, []);
  }
  assert.equal(getRuleTargetLength('https://user:pass@www.abc:8080/?pad=long'), 3);
  assert.equal(getRuleTargetLength('www.www.abc'), 7, 'only one www prefix is normalized away');
  assert.equal(getRuleTargetLength('a/||', true), 4, 'Whitelist path tokens remain literal');
});

test('saved short targets retain native compilation and runtime matching', () => {
  const rule = row('w');
  const native = createDnrRuleFactory(path => `https://extension.invalid/${path}`)(41, 'w', '', 'daily_limit');
  assert.equal(native.condition.urlFilter, '||w');
  assert.equal(doesUrlMatchBlockRule('https://www.wikipedia.org/article', rule.blockURL), true);
  assert.equal(isUrlInWhitelist('https://www.wikipedia.org/article', [row('w', true)]), true);
});

test('adding an existing short target to another list preserves its ID and Daily Limit', async () => {
  const original = row('ab');
  original.assignments[0] = { ...assignment(), blockingMode: 'daily_limit', dailyLimit: { minutes: 30 } };
  const f = fixture([original]);
  await f.service.addRule({ blockURL: 'HTTPS://www.ab/', assignment: assignment('list-1') });
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].id, original.id);
  assert.deepEqual(f.rows()[0].assignments[0], original.assignments[0]);
  assert.equal(f.rows()[0].assignments[1].listId, 'list-1');
  assert.deepEqual(f.remaps, []);
});

test('moving a saved short target uses the existing Daily Limit remap', async () => {
  const original = row('ab');
  original.assignments[0] = { ...assignment(), blockingMode: 'daily_limit', dailyLimit: { minutes: 30 } };
  const f = fixture([original]);
  await f.service.updateRule({ ruleId: original.id, assignmentListId: 'general',
    assignment: { ...original.assignments[0], listId: 'list-1' } });
  assert.equal(f.rows()[0].id, original.id);
  assert.equal(f.rows()[0].assignments[0].listId, 'list-1');
  assert.deepEqual(f.remaps, [[original.id, 'general', original.id, 'list-1']]);
});

test('a short legacy target can be toggled without validation or loss of settings', async () => {
  const original = row('ab'), f = fixture([original]);
  await f.service.toggleRule({ ruleId: original.id, listId: 'general' });
  assert.equal(f.rows()[0].assignments[0].disabledByUser, true);
  await f.service.toggleRule({ ruleId: original.id, listId: 'general' });
  assert.deepEqual(f.rows(), [original]);
});

for (const isWhitelist of [false, true]) {
  test(`imports cannot introduce new short ${isWhitelist ? 'Whitelist' : 'blacklist'} targets`, async () => {
    const original = row('original.example'), f = fixture([original]);
    await assert.rejects(f.service.replaceAll({ rules: [row('valid.example'), row('abc', isWhitelist, 42)],
      ruleLists: lists, settings: { debugMode: true } }), tooShort);
    assert.deepEqual(f.rows(), [original]); assert.deepEqual(f.writes, []); assert.deepEqual(f.syncs, []);
  });
  test(`imports preserve an already saved short ${isWhitelist ? 'Whitelist' : 'blacklist'} target`, async () => {
    const original = row('ab', isWhitelist), f = fixture([original]);
    await f.service.replaceAll({ rules: [row('https://www.ab/', isWhitelist)], ruleLists: lists });
    assert.equal(f.rows()[0].blockURL, 'https://www.ab/');
    assert.equal(f.rows()[0].isWhitelist, isWhitelist);
    assert.equal(f.syncs.length, 1);
  });
}

test('Rule Packs use the same minimum and keep a batch atomic on invalid input', async () => {
  const f = fixture([], [{ id: 'valid', blockURL: 'valid.example' }, { id: 'short', blockURL: 'abc' }]);
  await assert.rejects(f.service.addMany({ packId: 'fixture', entryIds: ['valid', 'short'] }),
    error => error.code === 'rule_pack_invalid' && error.validationErrors.includes('blockurl_too_short'));
  assert.deepEqual(f.rows(), []); assert.deepEqual(f.writes, []); assert.deepEqual(f.syncs, []);
});

test('every bundled Rule Pack target meets the minimum', () => {
  const manager = new RulesManager();
  for (const pack of getRulePacks()) for (const entry of pack.entries) {
    assert.equal(manager.validateRule(entry.blockURL, '', null, pack.category).isValid, true, entry.blockURL);
  }
});

test('short input remains an expected rejection and is not recorded as a runtime error', () => {
  assert.equal(shouldRecordRulesTelemetryError({ code: 'validation_failed',
    validationErrors: ['blockurl_too_short'] }, 'rules:add'), false);
});

test('all installed locales explain the four-character minimum', async () => {
  const root = new URL('../_locales/', import.meta.url);
  for (const locale of await readdir(root)) {
    const data = JSON.parse(await readFile(new URL(`${locale}/messages.json`, root), 'utf8'));
    assert.match(data.blockurl_minlength.message, /4/, locale);
  }
});
