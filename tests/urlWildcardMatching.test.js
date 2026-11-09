import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';

const factory = createDnrRuleFactory(path => `https://extension.invalid/${path}`);

test('URL wildcards: the runtime implements zero-or-more characters from the production DNR filter', () => {
  const pattern = 'example.test/a*b';
  assert.equal(factory(1, pattern, '').condition.urlFilter, '||example.test/a*b');
  for (const [path, expected] of [['/ab', true], ['/axxb', true], ['/a/x/y/b', true], ['/a', false], ['/zab', false]]) {
    assert.equal(doesUrlMatchBlockRule(`https://example.test${path}`, pattern), expected, path);
  }
});

test('URL wildcards: ordered literal segments do not overlap or backtrack', () => {
  for (const [path, pattern, expected] of [
    ['/axbyc', '/a*b*c', true], ['/acb', '/a*b*c', false],
    ['/abbc', '/ab*bc', true], ['/abc', '/ab*bc', false],
    ['/ab', '/a**b***', true], ['/a/x/b/more', '/a**b***', true]
  ]) assert.equal(doesUrlMatchBlockRule(`https://example.test${path}`, `example.test${pattern}`), expected);
});

test('URL wildcards: domain-label anchoring and non-default ports remain significant', () => {
  for (const [url, expected] of [
    ['https://example.test:8080/feed/one/watch', true],
    ['https://m.example.test:8080/feed/one/watch/more', true],
    ['https://example.test:8081/feed/one/watch', false],
    ['https://notexample.test:8080/feed/one/watch', false]
  ]) assert.equal(doesUrlMatchBlockRule(url, 'example.test:8080/feed*/watch'), expected, url);
});

test('URL wildcards: literal parts retain percent-encoded path separators', () => {
  assert.equal(doesUrlMatchBlockRule('https://example.test/a%2Fxxb', 'example.test/a%2F*b'), true);
  assert.equal(doesUrlMatchBlockRule('https://example.test/a/xxb', 'example.test/a%2F*b'), false);
  assert.equal(doesUrlMatchBlockRule('https://example.test/a%2Ab', 'example.test/a%2Ab'), true);
  assert.equal(doesUrlMatchBlockRule('https://example.test/axxb', 'example.test/a%2Ab'), false);
});

test('URL wildcards: URL filters do not turn literal path characters into regular expressions', () => {
  const pattern = 'example.test/a+(b)[c].d*end';
  assert.equal(doesUrlMatchBlockRule('https://example.test/a+(b)[c].d/end/more', pattern), true);
  assert.equal(doesUrlMatchBlockRule('https://example.test/abccd/end', pattern), false);
});

test('URL wildcards: matching may cross a query boundary and preserves ordinary prefix rules', () => {
  assert.equal(doesUrlMatchBlockRule('https://example.test/a?next=b', 'example.test/a*b'), true);
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com/shorts/one', 'yout'), true);
  assert.equal(doesUrlMatchBlockRule('https://youtube.com/shorts/one', 'youtube.com/short'), true);
});

test('URL wildcards: invalid native filters never become match-all runtime rules', () => {
  for (const pattern of ['*', '*.example.test', '', '   ', 'bad host/приватне']) {
    assert.equal(doesUrlMatchBlockRule('https://example.test/a/b', pattern), false, pattern);
  }
});

test('URL wildcards: browser pages and protected request hosts are excluded', () => {
  for (const url of ['chrome://components/', 'moz-extension://components/page', 'file://components/page', 'ftp://components/page']) {
    assert.equal(doesUrlMatchBlockRule(url, 'com'), false, url);
  }
  assert.equal(doesUrlMatchBlockRule('https://accounts.google.com/a/watch', 'accounts.google.com/*/watch'), false);
});

test('URL wildcards: Daily Limit selection includes matching wildcard targets', () => {
  const rules = [{ id: 1, blockURL: 'example.test' }, { id: 2, blockURL: 'example.test/feed*/watch' }];
  assert.equal(findBestMatchingRule('https://example.test/feeds/one/watch', rules)?.id, 2);
  assert.equal(findBestMatchingRule('https://example.test/feeds/one/read', rules)?.id, 1);
});

test('URL wildcards: mixed end-anchor expressions are not partially expanded into false positives', () => {
  assert.equal(doesUrlMatchBlockRule('https://example.test/axend|tail', 'example.test/a*end|'), false);
});
