/**
 * Returns whether a stored blocking rule should currently be represented in
 * the browser's dynamic DNR rules.
 *
 * The function deliberately preserves the existing scheduling semantics and
 * accepts an injectable date for deterministic tests.
 */
export function isRuleActiveNow(
  rule,
  disabledCategories = [],
  focusSessionActive = false,
  now = new Date()
) {
  if (rule.isWhitelist === true) return false;

  if (focusSessionActive) {
    return true;
  }

  if (rule.disabledByUser) return false;
  if (disabledCategories.includes(rule.category)) return false;
  if (!rule.schedule) return true;

  const currentDay = now.getDay();
  if (!rule.schedule.days.includes(currentDay)) return false;

  const [startH, startM] = rule.schedule.startTime.split(':').map(Number);
  const [endH, endM] = rule.schedule.endTime.split(':').map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}
