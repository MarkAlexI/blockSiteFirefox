import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRuleListIds,
  getRuleListIds,
  isRuleInList,
  mergeRuleListIds,
  removeRuleListId
} from '../rules/ruleListMembership.js';

test('General is the fallback only when no profile membership exists', () => {
  assert.deepEqual(normalizeRuleListIds([]), ['general']);
  assert.deepEqual(normalizeRuleListIds(['general', 'list-1']), ['general', 'list-1']);
  assert.deepEqual(normalizeRuleListIds(['list-1', 'list-2', 'list-1']), ['list-1', 'list-2']);
});

test('legacy listId is read as a single membership', () => {
  assert.deepEqual(getRuleListIds({ listId: 'list-1' }), ['list-1']);
  assert.deepEqual(getRuleListIds({}), ['general']);
});

test('adding memberships preserves General as a real profile', () => {
  assert.deepEqual(mergeRuleListIds(['general'], ['list-1']), ['general', 'list-1']);
  assert.deepEqual(mergeRuleListIds(['list-1'], ['list-2']), ['list-1', 'list-2']);
  assert.deepEqual(mergeRuleListIds(['list-1'], ['general']), ['list-1', 'general']);
});

test('membership lookup remains target-level metadata', () => {
  const rule = { listIds: ['general', 'list-2'], isWhitelist: false };
  assert.equal(isRuleInList(rule, 'general'), true);
  assert.equal(isRuleInList(rule, 'list-2'), true);
  assert.equal(isRuleInList(rule, 'list-1'), false);
});

test('deleting the last membership falls back to General in migration helpers', () => {
  assert.deepEqual(removeRuleListId(['list-1', 'list-2'], 'list-2'), ['list-1']);
  assert.deepEqual(removeRuleListId(['list-1'], 'list-1'), ['general']);
});
