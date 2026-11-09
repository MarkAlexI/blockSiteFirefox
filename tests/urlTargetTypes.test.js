import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnrRuleFactory, InvalidDnrUrlFilterError } from '../rules/dnrRuleFactory.js';
import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';
import { RulesManager } from '../rules/rulesManager.js';

const invalidTargets = [undefined, null, false, true, 0, 42, {}, [], ['broken'], { toString: null }];
const factory = createDnrRuleFactory(path => 'https://extension.invalid/' + path);

test('Target types: the bound factory classifies non-string targets as invalid filters', () => {
  for (const value of invalidTargets) {
    assert.throws(() => factory(1, value, ''), InvalidDnrUrlFilterError);
  }
});

test('Target types: runtime matching never coerces saved JSON values into URL fragments', () => {
  for (const [value, url] of [
    [true, 'https://true.example/page'], [42, 'https://0.0.0.42/page'],
    [['broken'], 'https://broken.example/page'], [{ toString: null }, 'https://safe.example/page'],
    [null, 'https://safe.example/page'], [undefined, 'https://safe.example/page']
  ]) assert.equal(doesUrlMatchBlockRule(url, value), false);
  const valid = { id: 2, blockURL: 'brok' };
  assert.equal(findBestMatchingRule('https://broken.example/page', [{ id: 1, blockURL: ['broken'] }, valid]), valid);
});

test('Target types: corrupted saved rows do not prevent valid conflict checks', () => {
  const manager = new RulesManager();
  const corrupt = invalidTargets.flatMap(blockURL => [{ blockURL, isWhitelist: false }, { blockURL, isWhitelist: true }]);
  const rules = [...corrupt, { blockURL: 'allowed.example', isWhitelist: true },
    { blockURL: 'blocked.example', isWhitelist: false }];
  assert.equal(manager.checkConflict(rules, 'unrelated.example', false), null);
  assert.equal(manager.checkConflict(rules, 'allowed', false), 'conflict_whitelist');
  assert.equal(manager.checkConflict(rules, 'allowed', true), 'redundant_whitelist');
  assert.equal(manager.checkConflict(rules, 'blocked', true), 'conflict_blacklist');
});

test('Target types: string fragments retain their existing normalization and matching', () => {
  for (const [pattern, filter, url] of [
    ['w', '||w', 'https://m.wikipedia.org/article'],
    ['broken', '||broken', 'https://broken.example/page'],
    ['42', '||0.0.0.42', 'https://0.0.0.42/page'],
    ['example.test:8080/a%2Fb', '||example.test:8080/a%2Fb', 'https://example.test:8080/a%2Fb'],
    ['example.test^p:*:end^|', '||example.test^p:*:end^|', 'https://example.test/p:one:end']
  ]) {
    assert.equal(factory(1, pattern, '').condition.urlFilter, filter);
    assert.equal(doesUrlMatchBlockRule(url, pattern), true);
  }
});
