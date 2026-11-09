import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnrRuleFactory, createDnrUrlFilter, InvalidDnrUrlFilterError } from '../rules/dnrRuleFactory.js';
import { normalizePathRule } from '../rules/normalizePathRule.js';
import { RulesManager } from '../rules/rulesManager.js';
import { doesUrlMatchBlockRule } from '../rules/urlRuleMatcher.js';

const emptyTargets = ['www.', 'www./', 'WWW.', 'http://www.', 'https://www./',
  'www.?q=1#section', 'https://www./?q=1#section', 'www%2e', '  www./  '];
const factory = createDnrRuleFactory(path => 'https://extension.invalid/' + path);
const manager = new RulesManager();

test('Empty targets: nonempty input cannot compile to a bare domain anchor', () => {
  for (const pattern of emptyTargets) {
    assert.equal(normalizePathRule(pattern.trim()), '', pattern);
    assert.throws(() => createDnrUrlFilter(pattern), InvalidDnrUrlFilterError, pattern);
    for (const redirect of ['', 'https://safe.example/target']) {
      assert.throws(() => factory(1, pattern, redirect), InvalidDnrUrlFilterError, pattern);
    }
  }
});

test('Empty targets: validation rejects collapsed targets before they can be saved', () => {
  for (const pattern of emptyTargets) {
    assert.deepEqual(manager.validateRule(pattern, '', null, 'social'),
      { isValid: false, errors: ['blockurl_invalid'] }, pattern);
    assert.equal(doesUrlMatchBlockRule('https://any.example/page', pattern), false, pattern);
  }
});

test('Empty targets: one-character fragments and nonempty normalized paths remain supported', () => {
  for (const [pattern, filter] of [
    ['w', '||w'], ['www', '||www'], ['yout', '||yout'],
    ['https://www.youtube.com/shorts/', '||youtube.com/shorts'],
    ['www./path', '||/path'],
    ['example.test:8080/a%2Fb', '||example.test:8080/a%2Fb'],
    ['example.test/feed*/watch', '||example.test/feed*/watch'],
    ['example.test^p:*:end^|', '||example.test^p:*:end^|']
  ]) {
    assert.equal(factory(1, pattern, '').condition.urlFilter, filter, pattern);
    assert.deepEqual(manager.validateRule(pattern, '', null, 'social'), { isValid: true, errors: [] }, pattern);
  }
  assert.equal(doesUrlMatchBlockRule('https://m.wikipedia.org/article', 'w'), true);
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com/watch', 'yout'), true);
});
