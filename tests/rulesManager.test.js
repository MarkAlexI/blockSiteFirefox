import test from 'node:test';
import assert from 'node:assert/strict';

import { RulesManager } from '../rules/rulesManager.js';

const manager = new RulesManager();

test('flexible partial block patterns remain valid', () => {
  for (const pattern of [
    'tube',
    'youtube.com/shorts',
    'example.com/path',
    'example.com:8080/path',
    'intranet:8080/path'
  ]) {
    const result = manager.validateRule(pattern, '', null, 'social');
    assert.equal(result.isValid, true, pattern);
  }
});

test('explicit non-web schemes are rejected for blacklist and whitelist rules', () => {
  for (const pattern of [
    'file:///tmp/page.html',
    'data:text/html,test',
    'ftp://example.com/file',
    'chrome://settings/',
    'about:config',
    'javascript:alert(1)'
  ]) {
    for (const isWhitelist of [false, true]) {
      const result = manager.validateRule(pattern, '', null, 'social', isWhitelist);
      assert.equal(result.isValid, false, `${pattern} whitelist=${isWhitelist}`);
      assert.equal(result.errors.includes('blockurl_restrict'), true, pattern);
    }
  }
});

test('redirect validation accepts only complete HTTP and HTTPS URLs', () => {
  for (const redirect of ['https://safe.example/path', 'HTTP://safe.example/path']) {
    assert.deepEqual(
      manager.validateRule('example.com', redirect, null, 'social'),
      { isValid: true, errors: [] },
      redirect
    );
  }

  for (const redirect of [
    'file:///tmp/page.html',
    'data:text/html,test',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'safe.example'
  ]) {
    const result = manager.validateRule('example.com', redirect, null, 'social');
    assert.equal(result.isValid, false, redirect);
    assert.equal(result.errors.includes('redirect_invalid'), true, redirect);
  }
});

test('validation preserves all localization keys for multiple failures', () => {
  const result = manager.validateRule(
    '',
    'not a redirect URL',
    {
      days: [9],
      startTime: '11:00',
      endTime: '11:00'
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
  for (const pattern of ['markdigital.cc', 'blockdistraction']) {
    const result = manager.validateRule(pattern, '', null, '', true);
    assert.deepEqual(result, { isValid: true, errors: [] }, pattern);
  }
});

test('blacklist validation still rejects protected extension and project patterns', () => {
  for (const pattern of ['markdigital.cc', 'blockdistraction']) {
    const result = manager.validateRule(pattern, '', null, 'other', false);
    assert.equal(result.isValid, false, pattern);
    assert.equal(result.errors.includes('blockurl_restrict'), true, pattern);
  }
});

test('competitor and partial Mark Digital patterns remain blockable', () => {
  for (const pattern of ['markdigital.com', 'markdigital', 'mark', 'digital']) {
    const result = manager.validateRule(pattern, '', null, 'other', false);
    assert.deepEqual(result, { isValid: true, errors: [] }, pattern);
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

test('rule validation accepts overnight schedules and rejects zero-duration periods', () => {
  for (const schedule of [
    { days: [5], startTime: '22:00', endTime: '06:00' },
    { version: 2, periods: [{ days: [0], startTime: '23:00', endTime: '05:00' }] }
  ]) {
    assert.deepEqual(
      manager.validateRule('night.example', '', schedule, 'social', false, 'schedule'),
      { isValid: true, errors: [] }
    );
  }

  assert.equal(
    manager.validateRule(
      'night.example', '', { days: [1], startTime: '22:00', endTime: '22:00' }, 'social', false, 'schedule'
    ).errors.includes('start_after_end'),
    true
  );
});
