import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_SCHEDULE,
  BLOCKING_MODE_DAILY_LIMIT,
  isDailyLimitReached
} from './blockingMode.js';
import {
  getAssignmentUsageSeconds,
  getRuleAssignment
} from './ruleAssignments.js';
import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isPeriodActive(period, now) {
  const currentDay = now.getDay();
  if (!Array.isArray(period.days) || !period.days.includes(currentDay)) return false;
  if (!TIME_PATTERN.test(period.startTime || '') || !TIME_PATTERN.test(period.endTime || '')) return false;

  const [startHour, startMinute] = period.startTime.split(':').map(Number);
  const [endHour, endMinute] = period.endTime.split(':').map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

export function isAssignmentBlockingNow(assignment, ruleId, now = new Date(), dailyUsageSeconds = {}) {
  if (!assignment) return false;
  if (assignment.disabledByUser === true) return false;
  if (assignment.blockingMode === BLOCKING_MODE_ALWAYS) return true;

  if (assignment.blockingMode === BLOCKING_MODE_DAILY_LIMIT) {
    return isDailyLimitReached(
      assignment,
      getAssignmentUsageSeconds(dailyUsageSeconds, ruleId, assignment.listId)
    );
  }

  if (assignment.blockingMode !== BLOCKING_MODE_SCHEDULE || !assignment.schedule) return false;
  const normalizedSchedule = normalizeSchedule(assignment.schedule);
  return normalizedSchedule.periods.some(period => isPeriodActive(period, now));
}

export function getActiveProfileAssignment(rule, activeRuleListId = GENERAL_RULE_LIST_ID) {
  return getRuleAssignment(rule, activeRuleListId);
}

export function getTrackableDailyLimitAssignments(
  rule,
  activeRuleListId = GENERAL_RULE_LIST_ID,
  now = new Date(),
  dailyUsageSeconds = {}
) {
  const assignment = getActiveProfileAssignment(rule, activeRuleListId);
  if (
    !assignment ||
    assignment.disabledByUser === true ||
    assignment.blockingMode !== BLOCKING_MODE_DAILY_LIMIT
  ) return [];
  if (isAssignmentBlockingNow(assignment, rule.id, now, dailyUsageSeconds)) return [];
  return [assignment];
}

/**
 * Returns whether a stored blacklist target should currently be represented in
 * dynamic DNR rules. Outside Focus Session only the assignment belonging to
 * the single active Rule List profile participates in normal activation.
 */
export function isRuleActiveNow(
  rule,
  disabledCategories = [],
  focusSessionActive = false,
  now = new Date(),
  activeRuleListId = GENERAL_RULE_LIST_ID,
  dailyUsageSeconds = {}
) {
  if (rule.isWhitelist === true) return false;
  if (focusSessionActive) return true;
  if (disabledCategories.includes(rule.category)) return false;

  const assignment = getActiveProfileAssignment(rule, activeRuleListId);
  return isAssignmentBlockingNow(assignment, rule.id, now, dailyUsageSeconds);
}
