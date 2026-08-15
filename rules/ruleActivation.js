import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_SCHEDULE,
  BLOCKING_MODE_DAILY_LIMIT,
  getRuleBlockingMode,
  isDailyLimitReached
} from './blockingMode.js';

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

/**
 * Returns whether a stored blocking rule should currently be represented in
 * the browser's dynamic DNR rules.
 *
 * Both legacy single-period schedules and version 2 multi-period schedules are
 * accepted. The injectable date keeps the function deterministic in tests.
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
  if (disabledRuleListIds.includes(rule.listId || 'general')) return false;

  const blockingMode = getRuleBlockingMode(rule);

  if (blockingMode === BLOCKING_MODE_ALWAYS) return true;

  if (blockingMode === BLOCKING_MODE_DAILY_LIMIT) {
    return isDailyLimitReached(rule, dailyUsageSeconds[String(rule.id)] || 0);
  }

  if (blockingMode !== BLOCKING_MODE_SCHEDULE || !rule.schedule) return false;

  const normalizedSchedule = normalizeSchedule(rule.schedule);
  return normalizedSchedule.periods.some(period => isPeriodActive(period, now));
}
