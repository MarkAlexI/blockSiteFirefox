import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRulesTelemetryCode,
  shouldRecordRulesTelemetryError
} from '../telemetry/telemetryRuleError.js';

test('rule telemetry preserves controlled mutation error codes', () => {
  assert.equal(getRulesTelemetryCode({
    name: 'RulesMutationError',
    code: 'rule_limit_reached'
  }), 'rule_limit_reached');

  assert.equal(getRulesTelemetryCode({
    name: 'RulesMutationError',
    code: 'rule_already_exists'
  }), 'rule_already_exists');
});

test('rule telemetry exposes only the first known validation code', () => {
  assert.equal(getRulesTelemetryCode({
    name: 'RulesMutationError',
    code: 'validation_failed',
    validationErrors: ['blockurl_invalid', 'redirect_invalid']
  }), 'blockurl_invalid');

  assert.equal(getRulesTelemetryCode({
    name: 'RulesMutationError',
    code: 'validation_failed',
    validationErrors: ['https://private.example/path']
  }), 'validation_failed');
});

test('expected rule rejections are excluded from reliability errors', () => {
  const expectedRejections = [
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
    'category_required'
  ];

  for (const code of expectedRejections) {
    assert.equal(shouldRecordRulesTelemetryError({
      name: 'RulesMutationError',
      code
    }), false, code);
  }
});

test('unexpected rule failures remain reliability errors', () => {
  for (const code of [
    'rule_pack_unavailable',
    'rule_pack_not_found',
    'rule_pack_invalid',
    'rule_not_found',
    'storage_failed'
  ]) {
    assert.equal(shouldRecordRulesTelemetryError({
      name: 'RulesMutationError',
      code
    }), true, code);
  }

  assert.equal(shouldRecordRulesTelemetryError(null), true);
});

test('unknown rule errors fall back to a coarse safe code', () => {
  assert.equal(getRulesTelemetryCode({
    code: 'https://private.example/path'
  }), 'intent_failed');
  assert.equal(getRulesTelemetryCode(null), 'intent_failed');
});
