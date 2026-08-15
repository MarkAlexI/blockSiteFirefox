import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';
import {
  addRuleAssignment,
  getRuleAssignment,
  getRuleAssignments,
  getRuleListIds,
  isRuleInList,
  isRuleListMembershipActive,
  removeRuleAssignment
} from './ruleAssignments.js';

function normalizeCandidateIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) return [value];
  return [];
}

export function normalizeRuleListIds(value, fallbackListId = GENERAL_RULE_LIST_ID) {
  const rawIds = normalizeCandidateIds(value);
  const uniqueIds = [];
  const seen = new Set();
  for (const rawId of rawIds) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }
  const customIds = uniqueIds.filter(id => id !== GENERAL_RULE_LIST_ID);
  if (customIds.length > 0) return customIds;
  const fallback = typeof fallbackListId === 'string' && fallbackListId.trim()
    ? fallbackListId.trim()
    : GENERAL_RULE_LIST_ID;
  return [fallback];
}

export { getRuleAssignments, getRuleAssignment, getRuleListIds, isRuleInList, isRuleListMembershipActive };

export function mergeRuleListIds(existingValue, addedValue) {
  const pseudoRule = { listIds: normalizeRuleListIds(existingValue), isWhitelist: false };
  let assignments = getRuleAssignments(pseudoRule);
  for (const listId of normalizeRuleListIds(addedValue)) {
    assignments = addRuleAssignment({ assignments, isWhitelist: false }, { listId, blockingMode: 'always' });
  }
  return assignments.map(item => item.listId);
}

export function removeRuleListId(existingValue, removedListId) {
  const pseudoRule = { listIds: normalizeRuleListIds(existingValue), isWhitelist: false };
  return removeRuleAssignment(pseudoRule, removedListId).map(item => item.listId);
}

export function areRuleListIdsEqual(left, right) {
  const leftIds = normalizeRuleListIds(left);
  const rightIds = normalizeRuleListIds(right);
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}
