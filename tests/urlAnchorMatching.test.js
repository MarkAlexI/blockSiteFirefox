import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';

const factory = createDnrRuleFactory(path => `https://extension.invalid/${path}`);
const matches = (path, pattern) => doesUrlMatchBlockRule(`https://example.test${path}`, pattern);

test('URL anchors: a separator matches one non-word URL boundary', () => {
  const pattern = 'example.test^s:item^x';
  assert.equal(factory(1, pattern, '').condition.urlFilter, `||${pattern}`);
  for (const [path, expected] of [
    ['/s:item/x', true], ['/s:item?x', true], ['/s:item=x', true],
    ['/s:item-x', false], ['/s:item_x', false], ['/s:item.x', false],
    ['/s:item%2Fx', false], ['/s:item9x', false]
  ]) assert.equal(matches(path, pattern), expected, path);
});

test('URL anchors: the final separator also matches the end of the URL', () => {
  const pattern = 'example.test^s:item^';
  for (const [path, expected] of [
    ['/s:item', true], ['/s:item/next', true], ['/s:item?q=1', true],
    ['/s:items', false], ['/s:item-extra', false], ['/s:item%2Fnext', false]
  ]) assert.equal(matches(path, pattern), expected, path);
});

test('URL anchors: only the final separator can consume zero characters', () => {
  assert.equal(matches('/s:item', 'example.test^s:item^^'), false);
  assert.equal(matches('/s:item/', 'example.test^s:item^^'), true);
  assert.equal(matches('/s:item', 'example.test^s:item^*'), true);
});

test('URL anchors: a right anchor requires the exact serialized URL end', () => {
  for (const [path, expected] of [
    ['/exact', true], ['/exact/more', false], ['/exact?q=1', false], ['/exacts', false], ['/exact|tail', false]
  ]) assert.equal(matches(path, 'example.test/exact|'), expected, path);
});

test('URL anchors: a wildcard may reach the last suffix instead of its first occurrence', () => {
  assert.equal(matches('/aend/mid/end', 'example.test/a*end|'), true);
  assert.equal(matches('/aend/mid/end/more', 'example.test/a*end|'), false);
  assert.equal(matches('/aend|tail', 'example.test/a*end|'), false);
});

test('URL anchors: ordered wildcard parts cannot overlap an anchored suffix', () => {
  assert.equal(matches('/abc', 'example.test/ab*bc|'), false);
  assert.equal(matches('/abbc', 'example.test/ab*bc|'), true);
  assert.equal(matches('/abXbcYbc', 'example.test/ab*bc|'), true);
  assert.equal(matches('/abXbcYdeYde', 'example.test/ab*bc*de|'), true);
});

test('URL anchors: wildcards, final separators and end anchors compose', () => {
  const pattern = 'example.test^p:*:end^|';
  for (const [path, expected] of [
    ['/p:one:end', true], ['/p:one:end/', true], ['/p::end', true],
    ['/p:one:end/more', false], ['/p:one:ended', false]
  ]) assert.equal(matches(path, pattern), expected, path);
});

test('URL anchors: a trailing wildcard makes a right anchor redundant', () => {
  assert.equal(matches('/a', 'example.test/a*|'), true);
  assert.equal(matches('/a/more?q=1', 'example.test/a*|'), true);
  assert.equal(matches('/s:item', 'example.test^s:item^*|'), true);
});

test('URL anchors: percent-encoded operators and interior pipes stay literal', () => {
  assert.equal(factory(1, 'example.test/a^b', '').condition.urlFilter, '||example.test/a%5Eb');
  assert.equal(matches('/a^b', 'example.test/a^b'), true);
  assert.equal(matches('/a/b', 'example.test/a^b'), false);
  assert.equal(matches('/a%7Cb', 'example.test/a%7Cb'), true);
  assert.equal(matches('/ab', 'example.test/a%7Cb'), false);
  assert.equal(matches('/a|b', 'example.test/a|b'), true);
  assert.equal(matches('/a/b', 'example.test/a|b'), false);
});

test('URL anchors: serialized trailing dots are preserved at domain boundaries', () => {
  assert.equal(doesUrlMatchBlockRule('https://example.test./path', 'example.test/path'), false);
  assert.equal(doesUrlMatchBlockRule('https://example.test./path', 'example.test./path|'), true);
  assert.equal(doesUrlMatchBlockRule('https://example.test./path', 'example.test^'), false);
  assert.equal(doesUrlMatchBlockRule('https://a.test./path', '^path'), true);
});

test('URL anchors: partial domains, request exclusions and invalid-filter protection remain intact', () => {
  assert.equal(doesUrlMatchBlockRule('https://m.youtube.com:8080/shorts/one', 'yout'), true);
  assert.equal(doesUrlMatchBlockRule('https://notyoutube.com/shorts/one', 'yout'), false);
  assert.equal(doesUrlMatchBlockRule('https://accounts.google.com/login', 'accounts.google.com^'), false);
  assert.equal(doesUrlMatchBlockRule('chrome://components/', 'com^'), false);
  assert.equal(doesUrlMatchBlockRule('https://example.test/path', '*|'), false);
  assert.equal(doesUrlMatchBlockRule('https://example.test/path', '|'), false);
});

test('URL anchors: a matching anchored target participates in Daily Limit selection', () => {
  const rules = [{ id: 1, blockURL: 'example.test' }, { id: 2, blockURL: 'example.test/exact|' }];
  assert.equal(findBestMatchingRule('https://example.test/exact', rules)?.id, 2);
  assert.equal(findBestMatchingRule('https://example.test/exact/more', rules)?.id, 1);
});
