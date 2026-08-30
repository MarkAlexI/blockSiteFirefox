export const RULE_PACK_ATTEMPT_COUNTERS = Object.freeze({
  social: 'rule_pack_attempt_social',
  messaging: 'rule_pack_attempt_messaging',
  video: 'rule_pack_attempt_video',
  'short-video': 'rule_pack_attempt_short_video',
  streaming: 'rule_pack_attempt_streaming',
  news: 'rule_pack_attempt_news',
  shopping: 'rule_pack_attempt_shopping',
  gaming: 'rule_pack_attempt_gaming'
});

export const RULE_PACK_TELEMETRY_COUNTERS = Object.freeze([
  'rule_pack_imported',
  'rule_pack_rules_added',
  'rule_pack_dialog_opened',
  ...Object.values(RULE_PACK_ATTEMPT_COUNTERS),
  'rule_pack_assignments_added',
  'rule_pack_duplicates_skipped',
  'rule_pack_conflicts',
  'rule_pack_no_change'
]);

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function getRulePackTelemetryIncrements(result = {}) {
  const packId = String(result?.packId || '');
  if (!Object.hasOwn(RULE_PACK_ATTEMPT_COUNTERS, packId)) return [];

  const addedCount = positiveInteger(result.addedCount);
  const newRuleCount = positiveInteger(result.newRuleCount ?? result.addedCount);
  const assignmentAddedCount = positiveInteger(
    result.assignmentAddedCount ?? result.membershipAddedCount
  );
  const duplicateCount = positiveInteger(result.skippedDuplicates);
  const conflictCount = Array.isArray(result.conflicts) ? result.conflicts.length : 0;
  const increments = [[RULE_PACK_ATTEMPT_COUNTERS[packId], 1]];

  if (addedCount > 0) increments.push(['rule_pack_imported', 1]);
  if (newRuleCount > 0) increments.push(['rule_pack_rules_added', newRuleCount]);
  if (assignmentAddedCount > 0) {
    increments.push(['rule_pack_assignments_added', assignmentAddedCount]);
  }
  if (duplicateCount > 0) {
    increments.push(['rule_pack_duplicates_skipped', duplicateCount]);
  }
  if (conflictCount > 0) increments.push(['rule_pack_conflicts', conflictCount]);
  if (addedCount === 0) increments.push(['rule_pack_no_change', 1]);

  return increments;
}
