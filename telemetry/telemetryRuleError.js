import { isExpectedRulesRejection } from '../rules/rulesErrorClassification.js';

const SAFE_RULE_ERROR_CODES = new Set([
  'pro_required',
  'rule_limit_reached',
  'validation_failed',
  'conflict_blacklist',
  'conflict_whitelist',
  'redundant_whitelist',
  'rule_already_exists',
  'rule_pack_unavailable',
  'rule_pack_not_found',
  'rule_pack_invalid_selection',
  'rule_pack_empty',
  'rule_pack_invalid',
  'rule_not_found',
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

const SAFE_VALIDATION_CODES = new Set([
  'blockurl_empty',
  'blockurl_restrict',
  'blockurl_invalid',
  'redirect_invalid',
  'category_required',
  'invalid_days',
  'schedule_day_overlap',
  'invalid_time_format',
  'start_after_end'
]);

export function getRulesTelemetryCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';

  if (code === 'validation_failed') {
    const validationErrors = Array.isArray(error?.validationErrors) ? error.validationErrors : [];
    const validationCode = validationErrors.find(item => SAFE_VALIDATION_CODES.has(item));
    return validationCode || 'validation_failed';
  }

  return SAFE_RULE_ERROR_CODES.has(code) ? code : 'intent_failed';
}

export function shouldRecordRulesTelemetryError(error) {
  return !isExpectedRulesRejection(error);
}
