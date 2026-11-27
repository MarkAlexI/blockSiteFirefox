import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/redirect.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
const extensionURL = 'extension://test-extension-id/';

function runPage(sendMessage, href = extensionURL + 'redirect.html?from=example.com&to=https%3A%2F%2Fphishing.example') {
  const destinations = [];
  const messages = [];
  const listeners = new Map();
  const location = { href, replace: url => destinations.push(url) };
  const currentTab = { id: 1, url: href };
  const tabs = { getCurrent: async () => ({ ...currentTab }) };
  const runtime = {
    getURL: path => extensionURL + path,
    sendMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); return sendMessage(message); }
  };
  vm.runInNewContext(source, {
    URL, location, window: { location, addEventListener: (type, listener) => listeners.set(type, listener) }, chrome: { runtime, tabs }, browser: { runtime, tabs },
    crypto: { randomUUID: () => 'document-token-0001' },
    Logger: class { info() {} error() {} }
  });
  return { destinations, messages, location, currentTab, tabs, leave: () => listeners.get('pagehide')?.() };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('an obsolete authorization leaves the user pending navigation untouched', async () => {
  const page = runPage(() => Promise.resolve({ success: false, obsolete: true }));
  await settle(); assert.deepEqual(page.destinations, []);
});

test('a late authorization cannot navigate a page after pagehide', async () => {
  let finish;
  const page = runPage(() => new Promise(resolve => { finish = resolve; }));
  page.leave(); finish({ success: true, to: 'https://chosen.example/' });
  await settle(); assert.deepEqual(page.destinations, []);
});

test('a changed document URL is not replaced by a delayed authorization or fallback', async () => {
  for (const response of [{ success: true, to: 'https://chosen.example/' }, { success: false }]) {
    let finish;
    const page = runPage(() => new Promise(resolve => { finish = resolve; }));
    page.location.href = 'https://newer.example/'; finish(response);
    await settle(); assert.deepEqual(page.destinations, []);
  }
});

test('a navigation that starts after authorization was requested wins over both redirect and fallback', async () => {
  for (const response of [{ success: true, to: 'https://chosen.example/' }, { success: false }]) {
    let finish;
    const page = runPage(() => new Promise(resolve => { finish = resolve; }));
    page.currentTab.pendingUrl = 'https://newer.example/'; finish(response);
    await settle(); assert.deepEqual(page.destinations, []);
  }
});

test('an unavailable native tab cannot be navigated by a late reply', async () => {
  let finish;
  const page = runPage(() => new Promise(resolve => { finish = resolve; }));
  page.tabs.getCurrent = async () => { throw new Error('Tab closed'); };
  finish({ success: true, to: 'https://chosen.example/' });
  await settle(); assert.deepEqual(page.destinations, []);
});

test('redirect page waits for one background authorization request', async () => {
  let finish;
  const reply = new Promise(resolve => { finish = resolve; });
  const page = runPage(() => reply);
  assert.deepEqual(page.destinations, []);
  assert.deepEqual(page.messages, [{ type: 'record_redirect', documentToken: 'document-token-0001' }]);
  finish({ success: true, to: 'https://chosen.example/path?q=1#section' });
  await settle();
  assert.deepEqual(page.destinations, ['https://chosen.example/path?q=1#section']);
});

test('redirect page ignores the query target and uses only the verified HTTP(S) reply', async () => {
  for (const to of ['https://chosen.example/план?q=a%20b', 'http://chosen.example:8080/path']) {
    const page = runPage(() => Promise.resolve({ success: true, to }));
    await settle();
    assert.deepEqual(page.destinations, [new URL(to).href]);
    assert.equal(page.messages.length, 1);
  }
});

test('redirect page falls back to blocked on denied, missing, or invalid authorization', async () => {
  for (const reply of [undefined, { success: false }, { success: true }, { success: true, to: 'javascript:alert(1)' }, { success: true, to: 'file:///tmp/page' }, { success: true, to: 'https://' }]) {
    const page = runPage(() => Promise.resolve(reply));
    await settle();
    assert.deepEqual(page.destinations, [extensionURL + 'blocked.html']);
  }
});

test('redirect page falls back to blocked when messaging rejects or throws', async () => {
  for (const send of [() => Promise.reject(new Error('Worker unavailable')), () => { throw new Error('No receiver'); }]) {
    const page = runPage(send);
    await settle();
    assert.deepEqual(page.destinations, [extensionURL + 'blocked.html']);
  }
});

test('redirect page without query parameters does not remain on the loading screen', async () => {
  const page = runPage(() => Promise.resolve({ success: false }), extensionURL + 'redirect.html');
  await settle();
  assert.deepEqual(page.destinations, [extensionURL + 'blocked.html']);
});
