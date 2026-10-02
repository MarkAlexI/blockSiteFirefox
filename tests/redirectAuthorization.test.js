import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRedirect } from '../utils/redirectAuthorization.js';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';

test('redirect authorization compares complete Chrome and Firefox extension URLs without relying on opaque origins', async () => {
  for (const protocol of ['chrome-extension:', 'moz-extension:']) {
    const runtimeApi = { id: 'public-extension-id', getURL: path => `${protocol}//internal-uuid/${path}` };
    const rule = createDnrRuleFactory(runtimeApi.getURL)(9, 'example.com', 'https://chosen.example/path');
    const sender = { id: runtimeApi.id, url: rule.action.redirect.url };
    let reads = 0;
    const dnrApi = { getDynamicRules: async () => { reads += 1; return [rule]; } };
    const request = { runtimeApi, dnrApi, isCurrent: () => true };
    assert.deepEqual(await authorizeRedirect({ ...request, sender }), { from: 'example.com', to: 'https://chosen.example/path' });
    for (const url of [
      sender.url.replace('internal-uuid', 'another-extension'),
      sender.url.replace(protocol, protocol === 'moz-extension:' ? 'chrome-extension:' : 'moz-extension:'),
      sender.url.replace('/redirect.html', '/redirect.html/child'),
      sender.url.replace('internal-uuid', 'user@internal-uuid')
    ]) {
      assert.equal(await authorizeRedirect({ ...request, sender: { ...sender, url } }), null);
    }
    assert.equal(reads, 1, 'invalid extension URLs do not require a DNR read');
  }
});

test('redirect authorization rejects ambiguous or malformed parameters even in an installed rule', async () => {
  const runtimeApi = { id: 'own', getURL: path => `moz-extension://uuid/${path}` };
  const original = createDnrRuleFactory(runtimeApi.getURL)(1, 'source.example', 'https://chosen.example');
  for (const edit of [
    url => url.searchParams.append('to', 'https://second.example'),
    url => url.searchParams.append('from', 'second.example'),
    url => url.searchParams.set('from', '%invalid'),
    url => url.searchParams.delete('from'),
    url => url.searchParams.delete('to')
  ]) {
    const url = new URL(original.action.redirect.url);
    edit(url);
    const rule = structuredClone(original);
    rule.action.redirect.url = url.href;
    const result = await authorizeRedirect({
      runtimeApi, sender: { id: 'own', url: url.href, frameId: 0 },
      dnrApi: { getDynamicRules: async () => [rule] }, isCurrent: () => true
    });
    assert.equal(result, null);
  }
});

test('redirect authorization finds an exact active rule in a large native DNR response with one read', async () => {
  const runtimeApi = { id: 'own', getURL: path => `chrome-extension://own/${path}` };
  const rule = createDnrRuleFactory(runtimeApi.getURL)(5000, 'source.example', 'https://chosen.example');
  const rules = Array.from({ length: 4999 }, (_, index) => ({ id: index + 1, action: { type: 'block' } }));
  rules.push(rule);
  let reads = 0;
  const result = await authorizeRedirect({
    runtimeApi, sender: { id: 'own', url: rule.action.redirect.url, frameId: 0 },
    dnrApi: { getDynamicRules: async () => { reads += 1; return rules; } }, isCurrent: () => true
  });
  assert.deepEqual(result, { from: 'source.example', to: 'https://chosen.example/' });
  assert.equal(reads, 1);
});
