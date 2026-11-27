import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesManager } from '../rules/rulesManager.js';
import { createDnrRuleFactory, assignDnrRulePriorities, createDnrUrlFilter } from '../rules/dnrRuleFactory.js';
import { doesUrlMatchBlockRule, findBestMatchingRule } from '../rules/urlRuleMatcher.js';
import { authorizeRedirect } from '../utils/redirectAuthorization.js';
import { isBlockedURL } from '../scripts/isBlockedURL.js';
import { getProtectedRequestDomains, isProtectedRequestHostname } from '../utils/protectedDomains.js';

test('empty hash: native end anchors distinguish absent, empty, and nonempty fragments', () => {
  for (const [pattern, tail, expected] of [
    ['example.test/p:item|', '', true], ['example.test/p:item|', '#', false],
    ['example.test/p:item|', '#section', false], ['example.test^p:item?|', '?', true],
    ['example.test^p:item?|', '?#', false], ['example.test^p:item^|', '#', true],
    ['example.test^p:item^|', '?#', false], ['example.test^p:item#|', '#', true],
    ['example.test^p:item#|', '', false], ['example.test^p:item?#|', '?#', true],
    ['example.test^p:item?#|', '?', false], ['example.test^p:item#section|', '#section', true],
    ['example.test^p:item?q=1#|', '?q=1#', true], ['example.test/p:item%23|', '%23', true]
  ]) assert.equal(doesUrlMatchBlockRule(`https://example.test/p:item${tail}`, pattern), expected, `${pattern} ${tail}`);
  const rules = [{ id: 1, blockURL: 'example.test/p:item|' }, { id: 2, blockURL: 'exam' }];
  assert.equal(findBestMatchingRule('https://example.test/p:item#', rules)?.id, 2);
});

test('bare web targets and full URL aliases use hostname protection instead of path text', () => {
  const manager = new RulesManager();
  for (const target of ['docs.example/blockdistraction', 'notblockdistraction.com',
    'docs.example/markdigital.cc', 'docs.example/ext.pp.ua',
    'accounts.google.com@ordinary.example/path', 'ordinary.example/?next=blockdistraction.com']) {
    for (const value of [target, `https://${target}`]) {
      assert.equal(isBlockedURL([{ url: value }]), false, value);
      assert.equal(manager.validateRule(value, '', null, 'social').isValid, true, value);
    }
    assert.equal(createDnrUrlFilter(target), createDnrUrlFilter(`https://${target}`));
  }
  for (const target of ['yout', 'block', 'markdigital', 'example.test^p:item?|']) {
    assert.equal(manager.validateRule(target, '', null, 'social').isValid, true, target);
  }
  for (const target of ['accounts.google.com', 'support.blockdistraction.com.', 'ext.pp.ua']) {
    assert.equal(isBlockedURL([{ url: target }]), true, target);
    assert.equal(isBlockedURL([{ url: `https://${target}/` }]), true, target);
  }
});

test('protected domain exclusions include absolute DNS names without rewriting rule targets', () => {
  const domains = getProtectedRequestDomains();
  for (const domain of ['accounts.google.com', 'blockdistraction.com', 'ext.pp.ua']) {
    assert.equal(domains.includes(`${domain}.`), true, domain);
    for (const hostname of [`${domain}.`, `sub.${domain}.`]) {
      assert.equal(isProtectedRequestHostname(hostname), true, hostname);
      assert.equal(doesUrlMatchBlockRule(`https://${hostname}/`, domain.slice(0, 4)), false, hostname);
    }
  }
  for (const hostname of ['blockdistraction.com.evil.test.', 'notblockdistraction.com.', 'example.test.',
    'blockdistraction.com..', 'sub.blockdistraction.com..']) {
    assert.equal(isProtectedRequestHostname(hostname), false, hostname);
  }
  assert.equal(createDnrUrlFilter('example.test./path|'), '||example.test./path|');
  assert.equal(doesUrlMatchBlockRule('https://example.test./path', 'example.test/path'), false);
});

test('redirect validation retains overlapping targets whose safe outcome depends on native priorities', () => {
  const manager = new RulesManager();
  for (const [pattern, destination] of [
    ['loop.example', 'https://loop.example/landing'], ['yout', 'https://m.youtube.com/watch'],
    ['example.test/team', 'http://example.test/team/more'],
    ['example.test:8080/team', 'http://example.test:8080/team'],
    ['example.test/a*b', 'https://example.test/a/one/b']
  ]) assert.equal(manager.validateRule(pattern, destination, null, 'social').isValid, true, `${pattern} ${destination}`);
  for (const [pattern, destination] of [
    ['example.test/team', 'https://example.test/other'], ['yout', 'https://notyoutube.com/'],
    ['example.test:8080/team', 'http://example.test:8081/team'],
    ['example.test/p:item|', 'https://example.test/p:item#'],
    ['block', 'https://blockdistraction.com./'], ['loop.example', 'https://safe.example/']
  ]) assert.equal(manager.validateRule(pattern, destination, null, 'social').isValid, true, `${pattern} ${destination}`);
});

const runtimeApi = { id: 'url-regression', getURL: path => `moz-extension://url-regression/${path}` };
const factory = createDnrRuleFactory(runtimeApi.getURL);
async function authorize(rules, source = rules[0]) {
  let reads = 0;
  const value = await authorizeRedirect({ runtimeApi,
    sender: { id: runtimeApi.id, url: source.action.redirect.url, frameId: 0, tab: { id: 7 } },
    dnrApi: { getDynamicRules: async () => { reads += 1; return rules; } }, isCurrent: () => true });
  assert.equal(reads, 1);
  return value;
}

test('installed legacy redirects fail closed for self, two-rule, and three-rule cycles', async () => {
  const self = factory(1, 'loop.example', 'https://loop.example/landing');
  assert.equal(await authorize([self]), null);
  const a = factory(1, 'first.example', 'https://second.example/');
  const b = factory(2, 'second.example', 'https://first.example/');
  assert.equal(await authorize([a, b]), null);
  const c = factory(3, 'third.example', 'https://first.example/');
  assert.equal(await authorize([a, factory(2, 'second.example', 'https://third.example/'), c]), null);
});

test('redirect cycle checks preserve safe chains, terminal blockers, and native overlap priority', async () => {
  const a = factory(1, 'first.example', 'https://second.example/team');
  const b = factory(2, 'second.example', 'https://first.example/');
  const terminal = factory(3, 'second.example/team', '');
  const safe = factory(4, 'second.example/team', 'https://safe.example/');
  for (const rules of [[a], [a, factory(2, 'second.example', 'https://safe.example/')],
    assignDnrRulePriorities([a, b, terminal]), assignDnrRulePriorities([a, b, safe])]) {
    assert.deepEqual(await authorize(rules), { from: 'first.example', to: 'https://second.example/team' });
  }
  const broad = factory(1, 'same.example', 'https://same.example/team');
  for (const specific of [factory(2, 'same.example/team', ''), factory(2, 'same.example/team', 'https://safe.example/')]) {
    assert.deepEqual(await authorize(assignDnrRulePriorities([broad, specific])),
      { from: 'same.example', to: 'https://same.example/team' });
  }
});

test('redirect cycle checks use installed compiled filters and preserve ports, hashes, and protected targets', async () => {
  const a = factory(1, 'first.example', 'https://example.test:8081/p:item#');
  const variants = [factory(2, 'example.test:8080', 'https://first.example/'),
    factory(2, 'example.test:8081/p:item|', 'https://first.example/'),
    factory(2, 'example.test^p:item#|', 'https://first.example/')];
  for (const b of variants) assert.deepEqual(await authorize([a, b]), { from: 'first.example', to: 'https://example.test:8081/p:item#' });
  const protectedRedirect = factory(1, 'block', 'https://blockdistraction.com./');
  assert.deepEqual(await authorize([protectedRedirect]), { from: 'block', to: 'https://blockdistraction.com./' });
  const cycle = [factory(1, 'first.example', 'https://m.youtube.com/'), factory(2, 'yout', 'https://first.example/')];
  assert.equal(await authorize(cycle), null);
});
