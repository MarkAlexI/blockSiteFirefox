import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/redirect.js', import.meta.url), 'utf8')
  .replace(/^import Logger from .*;\r?\n/m, '');
const extensionURL = 'extension://test-extension-id/';

function runPage(sendMessage, href = extensionURL + 'redirect.html?from=example.com&to=https%3A%2F%2Fphishing.example') {
  const destinations = [];
  const messages = [];
  const location = { href, replace: url => destinations.push(url) };
  const runtime = {
    getURL: path => extensionURL + path,
    sendMessage(message) { messages.push(JSON.parse(JSON.stringify(message))); return sendMessage(message); }
  };
  vm.runInNewContext(source, {
    URL, location, window: { location }, chrome: { runtime }, browser: { runtime },
    Logger: class { info() {} error() {} }
  });
  return { destinations, messages };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('redirect page waits for one background authorization request', async () => {
  let finish;
  const reply = new Promise(resolve => { finish = resolve; });
  const page = runPage(() => reply);
  assert.deepEqual(page.destinations, []);
  assert.deepEqual(page.messages, [{ type: 'record_redirect' }]);
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
