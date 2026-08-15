import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';

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

export function getRuleListIds(rule) {
  if (rule?.isWhitelist === true) return [GENERAL_RULE_LIST_ID];
  if (Array.isArray(rule?.listIds)) return normalizeRuleListIds(rule.listIds);
  return normalizeRuleListIds(rule?.listId);
}

export function isRuleInList(rule, listId) {
  return getRuleListIds(rule).includes(listId || GENERAL_RULE_LIST_ID);
}

export function isRuleListMembershipActive(rule, disabledRuleListIds = []) {
  const disabled = disabledRuleListIds instanceof Set
    ? disabledRuleListIds
    : new Set(disabledRuleListIds || []);

  return getRuleListIds(rule).some(listId => !disabled.has(listId));
}

export function mergeRuleListIds(existingValue, addedValue) {
  const existingIds = normalizeRuleListIds(existingValue);
  const addedIds = normalizeRuleListIds(addedValue);
  const addedCustomIds = addedIds.filter(id => id !== GENERAL_RULE_LIST_ID);

  if (addedCustomIds.length === 0) {
    return existingIds;
  }

  return normalizeRuleListIds([...existingIds, ...addedCustomIds]);
}

export function removeRuleListId(existingValue, removedListId) {
  const remaining = normalizeRuleListIds(existingValue)
    .filter(listId => listId !== removedListId);
  return normalizeRuleListIds(remaining);
}

export function areRuleListIdsEqual(left, right) {
  const leftIds = normalizeRuleListIds(left);
  const rightIds = normalizeRuleListIds(right);
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}
