export function isVisibleRuleGroupEnd(displayIndex, totalVisibleRules, groupSize = 10) {
  if (!Number.isInteger(displayIndex) || displayIndex < 0) return false;
  if (!Number.isInteger(totalVisibleRules) || totalVisibleRules <= 0) return false;
  if (!Number.isInteger(groupSize) || groupSize <= 0) return false;
  if (displayIndex >= totalVisibleRules - 1) return false;

  return (displayIndex + 1) % groupSize === 0;
}
