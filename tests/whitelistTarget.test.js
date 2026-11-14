import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesManager } from '../rules/rulesManager.js';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';
import { doesUrlMatchBlockRule } from '../rules/urlRuleMatcher.js';
import { normalizeWhitelistTarget, getWhitelistTargetKey } from '../pro/isUrlInWhitelist.js';

const manager = new RulesManager();
const allow = blockURL => ({ blockURL, isWhitelist: true });

test('Whitelist identity describes the existing matcher, including ignored ports and bounded paths', () => {
  const key = getWhitelistTargetKey('allowed.example/team');
  for (const input of [' HTTPS://WWW.Allowed.Example:8080/TEAM/?q=1#part ',
    'http://allowed.example/team/', 'allowed.example:8081/team#part']) {
    assert.equal(getWhitelistTargetKey(input), key, input);
    for (const url of ['https://sub.allowed.example/team', 'http://allowed.example:8082/TEAM/project']) {
      assert.equal(isUrlInWhitelist(url, [allow(input)]), true, input);
    }
  }
  assert.notEqual(getWhitelistTargetKey('allowed.example/teamwork'), key);
  assert.notEqual(getWhitelistTargetKey('allowed.example/team%2Farchive'), getWhitelistTargetKey('allowed.example/team/archive'));
  assert.notEqual(getWhitelistTargetKey('allowed.example./team'), key, 'do not change trailing-dot semantics');
});

test('Whitelist identity recognizes serialized international names and paths', () => {
  assert.equal(getWhitelistTargetKey('https://приклад.укр/шлях/'),
    getWhitelistTargetKey('xn--80aikifvh.xn--j1amh/%D1%88%D0%BB%D1%8F%D1%85'));
  for (const input of [null, true, 42, [], {}, 'www.', 'https://[bad']) {
    assert.equal(getWhitelistTargetKey(input), null);
    assert.equal(normalizeWhitelistTarget(input), null);
  }
});

for (const input of ['www.', '.', '..', 'https://[bad', '*.allowed.example', 'foo*.example', 'http://', 'allowed example']) {
  test(`Whitelist rejects an unusable new target: ${input}`, () => {
    assert.deepEqual(manager.validateRule(input, '', null, '', true), { isValid: false, errors: ['blockurl_invalid'] });
  });
}

test('Whitelist retains short fragments, literal path tokens, encoded separators and IPv6', () => {
  for (const [pattern, url, expected] of [
    ['tube', 'https://m.youtube.com/watch', true],
    ['w', 'https://m.wikipedia.org/article', true],
    ['42', 'https://0.0.0.42/page', true],
    ['localhost:8080/team', 'https://localhost:8081/team', true],
    ['[::1]:8080/team', 'http://[::1]:8081/team/sub', true],
    ['allowed.example/team*', 'https://allowed.example/team*/one', true],
    ['allowed.example/team*', 'https://allowed.example/teamwork', false],
    ['allowed.example/team', 'https://allowed.example/teamwork', false],
    ['allowed.example/a%2Fb', 'https://allowed.example/a/b', false]
  ]) {
    assert.equal(manager.validateRule(pattern, '', null, '', true).isValid, true, pattern);
    assert.equal(isUrlInWhitelist(url, [allow(pattern)]), expected, `${pattern}: ${url}`);
  }
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com/watch', 'yout'), true);
  assert.equal(doesUrlMatchBlockRule('https://notyoutube.com/watch', 'yout'), false);
});

for (const [blacklist, whitelist, conflict] of [
  ['https://other.test/?next=allowed.example#allowed.example', 'allowed.example', false],
  ['other.test/path/allowed.example', 'allowed.example', false],
  ['other.test/path/allowed.example*', 'allowed.example', false],
  ['notallowed.example', 'allowed.example', false],
  ['yout', 'other.test/yout', false],
  ['allowed.example/teamwork', 'allowed.example/team', false],
  ['allowed.example/tea', 'allowed.example/team', true],
  ['allowed.example/team/project', 'allowed.example/team', true],
  ['allowed.example/team*', 'allowed.example/team/project', true],
  ['https://WWW.allowed.example:8080/TEAM/', 'allowed.example/team', true],
  ['allowed.com', 'allowed.company', true],
  ['allowed.com/path', 'allowed.company/path', false],
  ['yout', 'youtube.com/shorts', true],
  ['youtube.com', 'tube', true]
]) {
  test(`rule conflicts use host/path scope: ${blacklist} versus ${whitelist}`, () => {
    assert.equal(manager.checkConflict([allow(whitelist)], blacklist, false), conflict ? 'conflict_whitelist' : null);
    assert.equal(manager.checkConflict([{ blockURL: blacklist }], whitelist, true), conflict ? 'conflict_blacklist' : null);
  });
}

test('Whitelist redundancy uses canonical scope and segment boundaries', () => {
  const rules = [allow('https://www.allowed.example:8080/TEAM/?q=1')];
  assert.equal(manager.ruleExists(rules, 'http://allowed.example/team/', '', -1, true), true);
  assert.equal(manager.checkConflict(rules, 'allowed.example/team', true), 'redundant_whitelist');
  assert.equal(manager.checkConflict(rules, 'sub.allowed.example/team/project', true), 'redundant_whitelist');
  assert.equal(manager.checkConflict(rules, 'allowed.example/teamwork', true), null);
  assert.equal(manager.checkConflict(rules, 'notallowed.example/team', true), null);
  assert.equal(manager.checkConflict(rules, 'allowed.example/team', true, 0), null);
  assert.equal(manager.checkConflict([allow('other.test/allowed.example')], 'allowed.example', true), null);
});

test('invalid saved Whitelist rows neither match nor obstruct a valid repair', () => {
  const invalid = [null, {}, allow('www.'), allow('https://[bad'), allow(['allowed.example'])];
  assert.equal(isUrlInWhitelist('https://allowed.example/team', invalid), false);
  assert.equal(isUrlInWhitelist('https://allowed.example/team', [...invalid, allow('allowed.example')]), true);
  assert.equal(manager.checkConflict(invalid.filter(Boolean), 'allowed.example', false), null);
});
