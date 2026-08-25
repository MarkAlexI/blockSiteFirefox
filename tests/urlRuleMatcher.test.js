import test from 'node:test';
import assert from 'node:assert/strict';

import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';

test('domain rules match the domain and subdomains', () => {
  assert.equal(doesUrlMatchBlockRule('https://youtube.com/watch?v=1', 'youtube.com'), true);
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com/watch?v=1', 'youtube.com'), true);
  assert.equal(doesUrlMatchBlockRule('https://notyoutube.com/', 'youtube.com'), false);
});


test('partial domain-label patterns preserve DNR-style matching', () => {
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com/watch?v=1', 'yout'), true);
  assert.equal(doesUrlMatchBlockRule('https://youtube.com/', 'yout'), true);
  assert.equal(doesUrlMatchBlockRule('https://notyoutube.com/', 'yout'), false);
});

test('partial rules never match protected OAuth or project request hosts', () => {
  assert.equal(doesUrlMatchBlockRule('https://accounts.youtube.com/accounts/SetSID', 'yout'), false);
  assert.equal(doesUrlMatchBlockRule('https://accounts.google.com/o/oauth2/auth', 'goog'), false);
  assert.equal(doesUrlMatchBlockRule('https://blockdistraction.com/login.html', 'block'), false);
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com/watch?v=1', 'yout'), true);
  assert.equal(doesUrlMatchBlockRule('https://www.google.com/search?q=test', 'goog'), true);
  assert.equal(doesUrlMatchBlockRule('https://blocking.example/', 'block'), true);
});

test('protected-domain names in unrelated hosts and paths never bypass blocking', () => {
  assert.equal(
    doesUrlMatchBlockRule('https://accounts.youtube.com.evil.example/', 'accounts'),
    true
  );
  assert.equal(
    doesUrlMatchBlockRule('https://evil.example/?next=accounts.google.com', 'evil'),
    true
  );
});

test('path rules use prefix semantics consistent with current blocking behavior', () => {
  assert.equal(doesUrlMatchBlockRule('https://youtube.com/shorts/abc', 'youtube.com/short'), true);
  assert.equal(doesUrlMatchBlockRule('https://youtube.com/watch?v=1', 'youtube.com/short'), false);
});

test('most specific matching daily-limit rule wins', () => {
  const rules = [
    { id: 1, blockURL: 'youtube.com' },
    { id: 2, blockURL: 'youtube.com/shorts' }
  ];
  assert.equal(findBestMatchingRule('https://youtube.com/shorts/abc', rules).id, 2);
});

test('protected authentication tabs never select a Daily Limit rule', () => {
  const rules = [{ id: 1, blockURL: 'yout' }];

  assert.equal(findBestMatchingRule('https://accounts.youtube.com/accounts/SetSID', rules), null);
  assert.equal(findBestMatchingRule('https://m.youtube.com/watch?v=1', rules).id, 1);
});
