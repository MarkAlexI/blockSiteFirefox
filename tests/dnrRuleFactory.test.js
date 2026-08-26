import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDnrRule,
  createDnrRuleFactory
} from '../rules/dnrRuleFactory.js';
import { getProtectedRequestDomains } from '../utils/protectedDomains.js';

const defaultRedirectURL = 'chrome-extension://extension-id/blocked.html';
const intermediaryRedirectURL = 'chrome-extension://extension-id/redirect.html';

test('DNR factory preserves flexible block pattern behavior', () => {
  const rule = createDnrRule({
    id: 7,
    blockURL: 'https://www.example.com/path/',
    redirectURL: '',
    defaultRedirectURL,
    intermediaryRedirectURL
  });

  assert.equal(rule.id, 7);
  assert.equal(rule.priority, 100);
  assert.equal(rule.condition.urlFilter, '||example.com/path');
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);

  const redirect = new URL(rule.action.redirect.url);
  assert.equal(redirect.pathname, '/blocked.html');
  assert.equal(
    redirect.searchParams.get('url'),
    encodeURIComponent('https://www.example.com/path/')
  );
});

test('custom redirects use the intermediary page with from and to parameters', () => {
  const rule = createDnrRule({
    id: 3,
    blockURL: 'tube',
    redirectURL: 'https://example.org/target',
    defaultRedirectURL,
    intermediaryRedirectURL
  });

  assert.equal(rule.condition.urlFilter, '||tube');

  const redirect = new URL(rule.action.redirect.url);
  assert.equal(redirect.pathname, '/redirect.html');
  assert.equal(redirect.searchParams.get('from'), encodeURIComponent('tube'));
  assert.equal(redirect.searchParams.get('to'), 'https://example.org/target');
});

test('bound factory resolves runtime URLs only once', () => {
  const requestedPaths = [];
  const factory = createDnrRuleFactory(path => {
    requestedPaths.push(path);
    return `chrome-extension://extension-id/${path}`;
  });

  const first = factory(1, 'one.example', '');
  const second = factory(2, 'two.example', '');

  assert.deepEqual(requestedPaths, ['blocked.html', 'redirect.html']);
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
});

test('every DNR rule excludes exact OAuth, project, and browser-store request domains', () => {
  const rule = createDnrRule({
    id: 19,
    blockURL: 'yout',
    redirectURL: 'https://example.org/target',
    defaultRedirectURL,
    intermediaryRedirectURL
  });

  assert.equal(rule.condition.urlFilter, '||yout');
  assert.deepEqual(rule.condition.excludedRequestDomains, [...getProtectedRequestDomains()]);
  assert.equal(rule.condition.excludedRequestDomains.includes('accounts.google.com'), true);
  assert.equal(rule.condition.excludedRequestDomains.includes('accounts.youtube.com'), true);
  assert.equal(rule.condition.excludedRequestDomains.includes('markdigital.cc'), true);
  assert.equal(rule.condition.excludedRequestDomains.includes('markdigital.com'), false);
  assert.equal(rule.condition.excludedRequestDomains.includes('youtube.com'), false);
  assert.equal(rule.condition.excludedRequestDomains.includes('google.com'), false);
});

test('DNR exclusions are copied per rule and cannot mutate the shared domain policy', () => {
  const factory = createDnrRuleFactory(path => {
    return `chrome-extension://extension-id/${path}`;
  });

  const first = factory(21, 'yout', '');
  const second = factory(22, 'goog', '');
  first.condition.excludedRequestDomains.pop();

  assert.deepEqual(second.condition.excludedRequestDomains, [...getProtectedRequestDomains()]);
  assert.notDeepEqual(first.condition.excludedRequestDomains, second.condition.excludedRequestDomains);
});
