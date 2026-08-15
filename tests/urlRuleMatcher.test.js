import test from 'node:test';
import assert from 'node:assert/strict';

import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';

test('domain rules match the domain and subdomains', () => {
  assert.equal(doesUrlMatchBlockRule('https://youtube.com/watch?v=1', 'youtube.com'), true);
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com/watch?v=1', 'youtube.com'), true);
  assert.equal(doesUrlMatchBlockRule('https://notyoutube.com/', 'youtube.com'), false);
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
