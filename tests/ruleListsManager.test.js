import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERAL_RULE_LIST_ID,
  RuleListsManager,
  createNextRuleListId,
  getDisabledRuleListIds,
  normalizeRuleLists,
  prepareImportedRuleLists
} from '../rules/ruleListsManager.js';

function createStorage(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    async get(key) { return { [key]: structuredClone(state[key]) }; },
    async set(values) { Object.assign(state, structuredClone(values)); }
  };
}

test('rule lists always expose General first and preserve its disabled state', () => {
  const lists = normalizeRuleLists([
    { id: 'list-2', name: 'Study', disabled: false },
    { id: GENERAL_RULE_LIST_ID, name: 'Ignored rename', disabled: true }
  ]);

  assert.deepEqual(lists, [
    { id: 'general', name: 'General', disabled: true },
    { id: 'list-2', name: 'Study', disabled: false }
  ]);
  assert.deepEqual(getDisabledRuleListIds(lists), ['general']);
});

test('invalid and duplicate custom lists are removed during normalization', () => {
  assert.deepEqual(normalizeRuleLists([
    { id: 'list-1', name: 'Work', disabled: false },
    { id: 'list-1', name: 'Duplicate id', disabled: false },
    { id: 'list-2', name: ' work ', disabled: false },
    { id: 'bad', name: 'Study', disabled: false }
  ]), [
    { id: 'general', name: 'General', disabled: false },
    { id: 'list-1', name: 'Work', disabled: false }
  ]);
});

test('new list IDs remain stable after deleted gaps', () => {
  assert.equal(createNextRuleListId([
    { id: 'general', name: 'General' },
    { id: 'list-1', name: 'Work' },
    { id: 'list-4', name: 'Study' }
  ]), 'list-5');
});

test('manager initializes missing storage with General', async () => {
  const storage = createStorage();
  const manager = new RuleListsManager(storage);
  const result = await manager.ensureInitialized();

  assert.equal(result.migrated, true);
  assert.deepEqual(storage.state.ruleLists, [
    { id: 'general', name: 'General', disabled: false }
  ]);
});

test('strict import validation rejects malformed or duplicate custom lists', () => {
  assert.throws(
    () => prepareImportedRuleLists([
      { id: 'general', name: 'General' },
      { id: 'list-1', name: 'Work' },
      { id: 'list-2', name: 'work' }
    ]),
    /Invalid or duplicate rule list/
  );
});
