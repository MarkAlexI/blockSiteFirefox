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
