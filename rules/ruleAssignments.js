import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_DAILY_LIMIT,
  BLOCKING_MODE_SCHEDULE,
  getRuleBlockingMode,
  normalizeBlockingConfig,
  normalizeDailyLimit
} from './blockingMode.js';
import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';

function normalizeListId(value, fallback = GENERAL_RULE_LIST_ID) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

function cloneSchedule(schedule) {
  return schedule ? normalizeSchedule(schedule) : null;
}

export function createRuleAssignment(listId = GENERAL_RULE_LIST_ID, blockingConfig = {}) {
  const normalizedListId = normalizeListId(listId);
  const config = normalizeBlockingConfig(blockingConfig);
  return {
    listId: normalizedListId,
    blockingMode: config.blockingMode,
    schedule: config.blockingMode === BLOCKING_MODE_SCHEDULE ? cloneSchedule(config.schedule) : null,
    dailyLimit: config.blockingMode === BLOCKING_MODE_DAILY_LIMIT ? normalizeDailyLimit(config.dailyLimit) : null
  };
}

export function createAlwaysAssignment(listId = GENERAL_RULE_LIST_ID) {
  return createRuleAssignment(listId, {
    blockingMode: BLOCKING_MODE_ALWAYS,
    schedule: null,
    dailyLimit: null
  });
}

function legacyListIds(rule = {}) {
  if (Array.isArray(rule.listIds)) return rule.listIds;
  if (typeof rule.listId === 'string' && rule.listId) return [rule.listId];
  return [GENERAL_RULE_LIST_ID];
}

function normalizeExistingAssignments(assignments = []) {
  const byListId = new Map();
  for (const raw of assignments) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const listId = normalizeListId(raw.listId);
    if (byListId.has(listId)) continue;
    byListId.set(listId, createRuleAssignment(listId, raw));
  }
  return [...byListId.values()];
}

function applyGeneralFallback(assignments) {
  const custom = assignments.filter(item => item.listId !== GENERAL_RULE_LIST_ID);
  if (custom.length > 0) return custom;
  return assignments.length > 0 ? assignments : [createAlwaysAssignment()];
}

export function normalizeRuleAssignments(rule = {}) {
  if (rule.isWhitelist === true) {
    return [createAlwaysAssignment(GENERAL_RULE_LIST_ID)];
  }

  if (Array.isArray(rule.assignments) && rule.assignments.length > 0) {
    return applyGeneralFallback(normalizeExistingAssignments(rule.assignments));
  }

  const legacyConfig = normalizeBlockingConfig({
    blockingMode: getRuleBlockingMode(rule),
    schedule: rule.schedule ?? null,
    dailyLimit: rule.dailyLimit ?? null
  });

  const seen = new Set();
  const assignments = [];
  for (const rawListId of legacyListIds(rule)) {
    const listId = normalizeListId(rawListId);
    if (seen.has(listId)) continue;
    seen.add(listId);
    assignments.push(createRuleAssignment(listId, legacyConfig));
  }

  return applyGeneralFallback(assignments);
}

export function getRuleAssignments(rule) {
  return normalizeRuleAssignments(rule);
}

export function getRuleAssignment(rule, listId) {
  const target = normalizeListId(listId);
  return getRuleAssignments(rule).find(item => item.listId === target) || null;
}

export function getRuleListIds(rule) {
  return getRuleAssignments(rule).map(item => item.listId);
}

export function isRuleInList(rule, listId) {
  return Boolean(getRuleAssignment(rule, listId));
}

export function isRuleListMembershipActive(rule, disabledRuleListIds = []) {
  const disabled = disabledRuleListIds instanceof Set
    ? disabledRuleListIds
    : new Set(disabledRuleListIds || []);
  return getRuleAssignments(rule).some(item => !disabled.has(item.listId));
}

export function addRuleAssignment(rule, assignment) {
  const next = getRuleAssignments(rule);
  const normalized = createRuleAssignment(assignment?.listId, assignment || {});
  if (next.some(item => item.listId === normalized.listId)) {
    return next;
  }

  const withoutGeneral = normalized.listId === GENERAL_RULE_LIST_ID
    ? next
    : next.filter(item => item.listId !== GENERAL_RULE_LIST_ID);
  return applyGeneralFallback([...withoutGeneral, normalized]);
}

export function replaceRuleAssignment(rule, sourceListId, assignment) {
  const source = normalizeListId(sourceListId);
  const normalized = createRuleAssignment(assignment?.listId, assignment || {});
  const current = getRuleAssignments(rule);
  const next = [];
  let replaced = false;

  for (const item of current) {
    if (item.listId === source) {
      if (!replaced) {
        next.push(normalized);
        replaced = true;
      }
      continue;
    }
    if (item.listId === normalized.listId) {
      throw new Error('rule_assignment_exists');
    }
    next.push(item);
  }

  if (!replaced) throw new Error('rule_assignment_not_found');
  return applyGeneralFallback(next);
}

export function removeRuleAssignment(rule, listId, { fallbackToGeneral = true } = {}) {
  const target = normalizeListId(listId);
  const current = getRuleAssignments(rule);
  const removed = current.find(item => item.listId === target) || null;
  const remaining = current.filter(item => item.listId !== target);

  if (remaining.length > 0) return remaining;
  if (!fallbackToGeneral) return [];

  const fallbackConfig = removed || createAlwaysAssignment();
  return [createRuleAssignment(GENERAL_RULE_LIST_ID, fallbackConfig)];
}

export function getAssignmentUsageKey(ruleId, listId) {
  const id = Math.floor(Number(ruleId));
  if (!Number.isInteger(id) || id <= 0) return null;
  return `${id}:${normalizeListId(listId)}`;
}

export function parseAssignmentUsageKey(value) {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const ruleId = Math.floor(Number(value.slice(0, separator)));
  const listId = value.slice(separator + 1).trim();
  if (!Number.isInteger(ruleId) || ruleId <= 0 || !listId) return null;
  return { ruleId, listId };
}

export function getAssignmentUsageSeconds(usageSeconds = {}, ruleId, listId) {
  const key = getAssignmentUsageKey(ruleId, listId);
  if (!key) return 0;
  if (Object.prototype.hasOwnProperty.call(usageSeconds, key)) {
    return Math.max(0, Number(usageSeconds[key]) || 0);
  }
  // Backward-compatible read during the one-time v1 -> v2 usage migration.
  return Math.max(0, Number(usageSeconds[String(ruleId)]) || 0);
}

export function areAssignmentsEqual(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}
