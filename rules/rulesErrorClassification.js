const EXPECTED_RULE_REJECTION_CODES = new Set([
  'pro_required',
  'rule_limit_reached',
  'validation_failed',
  'conflict_blacklist',
  'conflict_whitelist',
  'redundant_whitelist',
  'rule_already_exists',
  'rule_pack_invalid_selection',
  'rule_pack_empty',
  'invalid_import',
  'rule_list_name_invalid',
  'rule_list_name_exists',
  'rule_list_limit_reached',
  'rule_list_not_found',
  'rule_list_locked',
  'rule_assignment_exists',
  'rule_assignment_not_found',
  'rule_assignment_locked',
  'category_required'
]);

export function isExpectedRulesRejection(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return EXPECTED_RULE_REJECTION_CODES.has(code);
}
