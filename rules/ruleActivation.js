import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_SCHEDULE,
  BLOCKING_MODE_DAILY_LIMIT,
  isDailyLimitReached
} from './blockingMode.js';
import {
  getAssignmentUsageSeconds,
  getRuleAssignments
} from './ruleAssignments.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isPeriodActive(period, now) {
  const currentDay = now.getDay();
  if (!Array.isArray(period.days) || !period.days.includes(currentDay)) return false;
  if (!TIME_PATTERN.test(period.startTime || '') || !TIME_PATTERN.test(period.endTime || '')) {
    return false;
  }

  const [startHour, startMinute] = period.startTime.split(':').map(Number);
  const [endHour, endMinute] = period.endTime.split(':').map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

export function isAssignmentBlockingNow(assignment, ruleId, now = new Date(), dailyUsageSeconds = {}) {
  if (!assignment) return false;

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

export function getEnabledAssignments(rule, disabledRuleListIds = []) {
  const disabled = disabledRuleListIds instanceof Set
    ? disabledRuleListIds
    : new Set(disabledRuleListIds || []);
  return getRuleAssignments(rule).filter(item => !disabled.has(item.listId));
}

export function getTrackableDailyLimitAssignments(
  rule,
  disabledRuleListIds = [],
  now = new Date(),
  dailyUsageSeconds = {}
) {
  const enabled = getEnabledAssignments(rule, disabledRuleListIds);
  if (enabled.some(item => isAssignmentBlockingNow(item, rule.id, now, dailyUsageSeconds))) {
    return [];
  }
  return enabled.filter(item => item.blockingMode === BLOCKING_MODE_DAILY_LIMIT);
}

/**
 * Returns whether a stored blocking rule should currently be represented in
 * the browser's dynamic DNR rules.
 *
 * Assignment-specific blocking settings are OR-composed: a rule is active if
 * at least one assignment whose Rule List is enabled currently blocks.
 */
export function isRuleActiveNow(
  rule,
  disabledCategories = [],
  focusSessionActive = false,
  now = new Date(),
  disabledRuleListIds = [],
  dailyUsageSeconds = {}
) {
  if (rule.isWhitelist === true) return false;

  if (focusSessionActive) {
    return true;
  }

  if (rule.disabledByUser) return false;
  if (disabledCategories.includes(rule.category)) return false;

  return getEnabledAssignments(rule, disabledRuleListIds)
    .some(assignment => isAssignmentBlockingNow(assignment, rule.id, now, dailyUsageSeconds));
}
