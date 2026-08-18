import test from 'node:test';
import assert from 'node:assert/strict';

import { RulesManager } from '../rules/rulesManager.js';

const manager = new RulesManager();

test('flexible partial block patterns remain valid', () => {
  for (const pattern of ['tube', 'youtube.com/shorts', 'example.com/path']) {
    const result = manager.validateRule(pattern, '', null, 'social');
    assert.equal(result.isValid, true, pattern);
  }
});

test('validation preserves all localization keys for multiple failures', () => {
  const result = manager.validateRule(
    '',
    'not a redirect URL',
    {
      days: [9],
      startTime: '11:00',
      endTime: '10:00'
    },
    ''
  );

  assert.equal(result.isValid, false);
  assert.deepEqual(result.errors, [
    'blockurl_empty',
    'redirect_invalid',
    'invalid_days',
    'start_after_end',
    'category_required'
  ]);
});

test('whitelist validation ignores redirect, schedule, and category requirements', () => {
  const result = manager.validateRule(
    'allowed.example',
    'not a URL',
    { days: [9], startTime: 'bad', endTime: 'bad' },
    '',
    true
  );

  assert.deepEqual(result, { isValid: true, errors: [] });
});

test('whitelist validation allows protected extension and project patterns', () => {
  for (const pattern of ['markdigital', 'blockdistraction']) {
    const result = manager.validateRule(pattern, '', null, '', true);
    assert.deepEqual(result, { isValid: true, errors: [] }, pattern);
  }
});

test('blacklist validation still rejects protected extension and project patterns', () => {
  for (const pattern of ['markdigital', 'blockdistraction']) {
    const result = manager.validateRule(pattern, '', null, 'other', false);
    assert.equal(result.isValid, false, pattern);
    assert.equal(result.errors.includes('blockurl_restrict'), true, pattern);
  }
});

test('existing substring conflict behavior is preserved', () => {
  const rules = [{
    id: 1,
    blockURL: 'youtube.com',
    isWhitelist: false
  }];

  assert.equal(
    manager.checkConflict(rules, 'youtube.com/shorts', true),
    'conflict_blacklist'
  );
});

test('Daily limit mode accepts a valid budget and rejects mixed schedule configuration', () => {
  const valid = manager.validateRule(
    'youtube.com',
    '',
    null,
    'social',
    false,
    'daily_limit',
    { minutes: 30 }
  );
  assert.deepEqual(valid, { isValid: true, errors: [] });

  const mixed = manager.validateRule(
    'youtube.com',
    '',
    { version: 2, periods: [{ days: [1], startTime: '09:00', endTime: '10:00' }] },
    'social',
    false,
    'daily_limit',
    { minutes: 30 }
  );
  assert.equal(mixed.isValid, false);
  assert.equal(mixed.errors.includes('blocking_mode_conflict'), true);
});
