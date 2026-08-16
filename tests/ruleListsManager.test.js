import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERAL_RULE_LIST_ID,
  RuleListsManager,
  createNextRuleListId,
  normalizeRuleLists,
  normalizeActiveRuleListId,
  prepareImportedRuleLists
} from '../rules/ruleListsManager.js';

function createStorage(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    async get(keys) {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(key => [key, structuredClone(state[key])]));
      }
      return { [keys]: structuredClone(state[keys]) };
    },
    async set(values) { Object.assign(state, structuredClone(values)); }
  };
}

test('rule lists always expose General first with profile-scoped category state', () => {
  const lists = normalizeRuleLists([
    { id: 'list-2', name: 'Study', disabled: true, disabledCategories: ['news', 'bad'] },
    { id: GENERAL_RULE_LIST_ID, name: 'Ignored rename', disabledCategories: ['social'] }
  ]);

  assert.deepEqual(lists, [
    { id: 'general', name: 'General', disabledCategories: ['social'] },
    { id: 'list-2', name: 'Study', disabledCategories: ['news'] }
  ]);
});

test('invalid and duplicate custom profiles are removed during normalization', () => {
  assert.deepEqual(normalizeRuleLists([
    { id: 'list-1', name: 'Work' },
    { id: 'list-1', name: 'Duplicate id' },
    { id: 'list-2', name: ' work ' },
    { id: 'bad', name: 'Study' }
  ]), [
    { id: 'general', name: 'General', disabledCategories: [] },
    { id: 'list-1', name: 'Work', disabledCategories: [] }
  ]);
});

test('new list IDs remain stable after deleted gaps', () => {
  assert.equal(createNextRuleListId([
    { id: 'general', name: 'General' },
    { id: 'list-1', name: 'Work' },
    { id: 'list-4', name: 'Study' }
  ]), 'list-5');
});

test('manager initializes missing storage with General as the active profile', async () => {
  const storage = createStorage();
  const manager = new RuleListsManager(storage);
  const result = await manager.ensureInitialized();

  assert.equal(result.migrated, true);
  assert.deepEqual(storage.state.ruleLists, [
    { id: 'general', name: 'General', disabledCategories: [] }
  ]);
  assert.equal(storage.state.activeRuleListId, 'general');
});

test('legacy global disabled categories migrate into General only', async () => {
  const storage = createStorage({
    ruleLists: [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Study', disabled: false }
    ]
  });
  const manager = new RuleListsManager(storage);
  const result = await manager.ensureInitialized({ legacyDisabledCategories: ['social', 'news'] });

  assert.deepEqual(result.lists[0].disabledCategories, ['social', 'news']);
  assert.deepEqual(result.lists[1].disabledCategories, []);
  assert.equal(result.activeRuleListId, 'general');
});

test('active profile falls back to General when the stored id no longer exists', () => {
  const lists = normalizeRuleLists([{ id: 'list-1', name: 'Work' }]);
  assert.equal(normalizeActiveRuleListId(lists, 'list-1'), 'list-1');
  assert.equal(normalizeActiveRuleListId(lists, 'missing'), 'general');
});

test('strict import validation rejects malformed or duplicate custom profiles', () => {
  assert.throws(
    () => prepareImportedRuleLists([
      { id: 'general', name: 'General' },
      { id: 'list-1', name: 'Work' },
      { id: 'list-2', name: 'work' }
    ]),
    /Invalid or duplicate rule list/
  );
});
