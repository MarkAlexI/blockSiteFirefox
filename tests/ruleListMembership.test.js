import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRuleListIds,
  getRuleListIds,
  isRuleInList,
  isRuleListMembershipActive,
  mergeRuleListIds,
  removeRuleListId
} from '../rules/ruleListMembership.js';

test('General is a fallback and is removed when custom memberships exist', () => {
  assert.deepEqual(normalizeRuleListIds([]), ['general']);
  assert.deepEqual(normalizeRuleListIds(['general', 'list-1']), ['list-1']);
  assert.deepEqual(normalizeRuleListIds(['list-1', 'list-2', 'list-1']), ['list-1', 'list-2']);
});

test('legacy listId is read as a single membership', () => {
  assert.deepEqual(getRuleListIds({ listId: 'list-1' }), ['list-1']);
  assert.deepEqual(getRuleListIds({}), ['general']);
});

test('adding a custom membership moves General rules into the custom list and shares custom rules', () => {
  assert.deepEqual(mergeRuleListIds(['general'], ['list-1']), ['list-1']);
  assert.deepEqual(mergeRuleListIds(['list-1'], ['list-2']), ['list-1', 'list-2']);
  assert.deepEqual(mergeRuleListIds(['list-1'], ['general']), ['list-1']);
});

test('a shared rule remains active while at least one membership is enabled', () => {
  const rule = { listIds: ['list-1', 'list-2'], isWhitelist: false };
  assert.equal(isRuleInList(rule, 'list-1'), true);
  assert.equal(isRuleInList(rule, 'list-2'), true);
  assert.equal(isRuleListMembershipActive(rule, ['list-1']), true);
  assert.equal(isRuleListMembershipActive(rule, ['list-1', 'list-2']), false);
});

test('deleting the last custom membership falls back to General', () => {
  assert.deepEqual(removeRuleListId(['list-1', 'list-2'], 'list-2'), ['list-1']);
  assert.deepEqual(removeRuleListId(['list-1'], 'list-1'), ['general']);
});
