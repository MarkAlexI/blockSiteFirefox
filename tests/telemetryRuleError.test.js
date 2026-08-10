import test from 'node:test';
import assert from 'node:assert/strict';
import { getRulesTelemetryCode } from '../telemetry/telemetryRuleError.js';

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

test('unknown rule errors fall back to a coarse safe code', () => {
  assert.equal(getRulesTelemetryCode({
    code: 'https://private.example/path'
  }), 'intent_failed');
  assert.equal(getRulesTelemetryCode(null), 'intent_failed');
});
