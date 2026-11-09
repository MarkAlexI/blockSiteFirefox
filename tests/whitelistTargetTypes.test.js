import test from 'node:test';
import assert from 'node:assert/strict';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';

const entry = (blockURL, disabledByUser = false) => ({
  blockURL, isWhitelist: true,
  assignments: [{ listId: 'general', disabledByUser, blockingMode: 'always', schedule: null, dailyLimit: null }]
});

test('Whitelist target types: saved JSON values never become allowed URL patterns', () => {
  for (const [blockURL, url] of [
    [['allowed.example'], 'https://allowed.example/page'],
    [true, 'https://true.example/page'],
    [42, 'https://0.0.0.42/page'],
    [false, 'https://false.example/page'],
    [null, 'https://null.example/page'],
    [undefined, 'https://undefined.example/page']
  ]) assert.equal(isUrlInWhitelist(url, [entry(blockURL)]), false);
});

test('Whitelist target types: malformed entries cannot abort a later valid match', () => {
  const rules = [entry({ toString: null }), entry(['wrong.example']), entry({}),
    entry(null), null, undefined, entry('allowed.example')];
  assert.equal(isUrlInWhitelist('https://allowed.example/page', rules), true);
  assert.equal(isUrlInWhitelist('https://wrong.example/page', rules), false);
  assert.equal(isUrlInWhitelist('https://unlisted.example/page', rules), false);
});

test('Whitelist target types: string fragments, path boundaries and disabled assignments retain their behavior', () => {
  for (const [pattern, url, expected] of [
    ['w', 'https://m.wikipedia.org/article', true],
    ['tube', 'https://m.youtube.com/watch', true],
    ['true', 'https://true.example/page', true],
    ['42', 'https://0.0.0.42/page', true],
    ['https://WWW.Allowed.Example/team/', 'https://sub.allowed.example/TEAM/project', true],
    ['allowed.example/team', 'https://allowed.example/teamwork', false],
    ['allowed.example/team%2Farchive', 'https://allowed.example/team%2Farchive/page', true],
    ['allowed.example/team%2Farchive', 'https://allowed.example/team/archive/page', false],
    ['allowed.example', 'https://evil.example/?next=allowed.example', false]
  ]) assert.equal(isUrlInWhitelist(url, [entry(pattern)]), expected, pattern);
  assert.equal(isUrlInWhitelist('https://allowed.example/page', [entry('allowed.example', true)]), false);
});
