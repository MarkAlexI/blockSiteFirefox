import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePathRule } from '../rules/normalizePathRule.js';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';

const factory = createDnrRuleFactory(path => `https://extension.invalid/${path}`);

test('URL ports: normalization retains non-default ports and serialized paths', () => {
  for (const [input, expected] of [
    ['https://www.example.test:8080/a%2Fb/', 'example.test:8080/a%2Fb'],
    ['example.test:8080/path', 'example.test:8080/path'],
    ['intranet:8080/path', 'intranet:8080/path'],
    ['https://[2001:db8::1]:8080/path', '[2001:db8::1]:8080/path'],
    ['https://приклад.укр:8443/шлях', 'xn--80aikifvh.xn--j1amh:8443/%D1%88%D0%BB%D1%8F%D1%85']
  ]) assert.equal(normalizePathRule(input), expected, input);
});

test('URL ports: the production DNR factory retains the selected port', () => {
  for (const input of ['example.test:8080/path', 'https://www.example.test:8080/path/']) {
    assert.equal(factory(1, input, '').condition.urlFilter, '||example.test:8080/path');
  }
});

test('URL ports: a port-specific path matches only its serialized authority and path prefix', () => {
  for (const [url, expected] of [
    ['https://example.test:8080/path/one', true],
    ['https://m.example.test:8080/path/one', true],
    ['https://example.test:8081/path/one', false],
    ['https://example.test/path/one', false],
    ['https://example.test:8080/other', false],
    ['https://notexample.test:8080/path/one', false]
  ]) assert.equal(doesUrlMatchBlockRule(url, 'example.test:8080/path'), expected, url);
  assert.equal(doesUrlMatchBlockRule('http://[::1]:8080/a%2Fb', '[::1]:8080/a%2Fb'), true);
  assert.equal(doesUrlMatchBlockRule('http://[::1]:8081/a%2Fb', '[::1]:8080/a%2Fb'), false);
  assert.equal(doesUrlMatchBlockRule('http://[::1]:8080/a/b', '[::1]:8080/a%2Fb'), false);
});

test('URL ports: portless paths follow DNR URL syntax while short domain and port fragments stay supported', () => {
  assert.equal(doesUrlMatchBlockRule('https://example.test:8080/path', 'example.test/path'), false);
  for (const url of ['https://youtube.com:8080/watch', 'https://m.youtube.com:8081/watch']) {
    assert.equal(doesUrlMatchBlockRule(url, 'yout'), true, url);
    assert.equal(doesUrlMatchBlockRule(url, 'youtube.com'), true, url);
  }
  assert.equal(doesUrlMatchBlockRule('https://notyoutube.com:8080/watch', 'yout'), false);
  assert.equal(doesUrlMatchBlockRule('https://example.test:8080/path', 'example.test:808'), true);
});

test('URL ports: default-port canonicalization remains scheme-aware', () => {
  for (const input of ['http://example.test:80/path', 'https://example.test:443/path']) {
    assert.equal(normalizePathRule(input), 'example.test/path');
    assert.equal(doesUrlMatchBlockRule(input, input), true);
  }
  assert.equal(normalizePathRule('https://example.test:80/path'), 'example.test:80/path');
});

test('URL ports: Daily Limit selection distinguishes otherwise identical port-specific targets', () => {
  const rules = [
    { id: 1, blockURL: 'example.test:8080/path' },
    { id: 2, blockURL: 'example.test:8081/path' },
    { id: 3, blockURL: 'exam' }
  ];
  assert.equal(findBestMatchingRule('https://example.test:8081/path/one', rules)?.id, 2);
  assert.equal(findBestMatchingRule('https://example.test/path/one', rules)?.id, 3);
});

test('URL ports: protected request hosts stay protected on non-default ports', () => {
  assert.equal(doesUrlMatchBlockRule('https://accounts.google.com:8080/login', 'acc'), false);
  assert.equal(doesUrlMatchBlockRule('https://blockdistraction.com:8080/login', 'block'), false);
});
