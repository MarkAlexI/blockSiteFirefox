import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpectedRulesRejection } from '../rules/rulesErrorClassification.js';

test('user validation and business-rule rejections are expected', () => {
  for (const code of [
    'validation_failed',
    'rule_list_name_invalid',
    'rule_list_name_exists',
    'rule_list_limit_reached',
    'dnr_rule_limit_reached',
    'rule_already_exists',
    'pro_required',
    'invalid_import'
  ]) {
    assert.equal(isExpectedRulesRejection({ code }), true, code);
  }
});

test('unexpected runtime-style rule failures remain errors', () => {
  for (const code of ['storage_failed', 'dnr_failed', 'unknown']) {
    assert.equal(isExpectedRulesRejection({ code }), false, code);
  }
  assert.equal(isExpectedRulesRejection(null), false);
});

test('Pro rejection is unexpected for mutations that must remain available to Free users', () => {
  const error = { code: 'pro_required' };

  for (const intentType of [
    'rules:removeAssignment',
    'rules:delete',
    'rules:toggle'
  ]) {
    assert.equal(isExpectedRulesRejection(error, intentType), false, intentType);
  }

  assert.equal(isExpectedRulesRejection(error, 'rules:createList'), true);
});
