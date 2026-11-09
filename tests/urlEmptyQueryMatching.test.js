import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';

const exact = 'example.test/p:item|';
// The existing partial-filter syntax retains a literal query marker.
const query = 'example.test^p:item?|';

test('Empty query: right anchors distinguish an absent query from an explicit question mark', () => {
  for (const [url, expected] of [
    ['https://example.test/p:item', true],
    ['https://example.test/p:item?', false],
    ['https://m.example.test/p:item?', false],
    ['https://example.test/p:item?q=1', false],
    ['https://example.test/p:item%3F', false]
  ]) assert.equal(doesUrlMatchBlockRule(url, exact), expected, url);
});

test('Empty query: a literal final query marker matches only the serialized empty query', () => {
  const factory = createDnrRuleFactory(path => `https://extension.invalid/${path}`);
  assert.equal(factory(1, query, '').condition.urlFilter, `||${query}`);
  for (const [url, expected] of [
    ['https://example.test/p:item?', true],
    ['https://m.example.test/p:item?', true],
    ['https://example.test/p:item', false],
    ['https://example.test/p:item?q=1', false],
    ['https://example.test/p:item%3F', false],
    ['https://example.test/p:item#?', false]
  ]) assert.equal(doesUrlMatchBlockRule(url, query), expected, url);
});

test('Empty query: fragment text and escaped question marks never introduce an extra query delimiter', () => {
  for (const tail of ['#?end', '#section?end', '%3F', '?q=%3F', '?#section?end']) {
    const pattern = `example.test^p:item${tail}|`;
    assert.equal(doesUrlMatchBlockRule(`https://example.test/p:item${tail}`, pattern), true, tail);
  }
  for (const url of ['https://m.youtube.com/watch', 'https://m.youtube.com/watch?']) {
    assert.equal(doesUrlMatchBlockRule(url, 'yout'), true, url);
  }
});

test('Empty query: Daily Limit selection attributes each query form to its own target', () => {
  const rules = [{ id: 1, blockURL: exact }, { id: 2, blockURL: query }, { id: 3, blockURL: 'exam' }];
  assert.equal(findBestMatchingRule('https://example.test/p:item', rules)?.id, 1);
  assert.equal(findBestMatchingRule('https://example.test/p:item?', rules)?.id, 2);
  assert.equal(findBestMatchingRule('https://example.test/p:item?q=1', rules)?.id, 3);
});
