import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRulesConnection } from '../rules/rulesClient.js';

async function fixture(callback, { throws = false } = {}) {
  const previous = { chrome: globalThis.chrome, browser: globalThis.browser,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map(), requests = [];
  let serial = 0, reply;
  const api = { runtime: { lastError: null, sendMessage(message, done) {
    requests.push(message);
    if (throws) throw new Error('Extension context invalidated.');
    if (done) { reply = done;return; }
    return new Promise(resolve => { reply = resolve; });
  } } };
  globalThis.chrome = globalThis.browser = api;
  globalThis.setTimeout = fn => { const id = ++serial;timers.set(id, fn);return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  try {
    await callback({ requests, timers, respond: value => reply(value),
      expire() { const pending = [...timers.values()];timers.clear();for (const fn of pending) fn(); } });
  } finally { Object.assign(globalThis, previous); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the Options connection check is read-only and accepts only the known health response', async () => {
  await fixture(async f => {
    const request = checkRulesConnection();await settle();
    f.respond({ success: true, protocol: 1 });await request;
    assert.deepEqual(f.requests, [{ type: 'rules:health' }]);
    assert.equal(f.timers.size, 0);
  });
});

for (const response of [undefined, { success: false }, { success: true }, { success: true, protocol: 2 }]) {
  test(`missing, denied or incompatible health responses remain unavailable: ${JSON.stringify(response)}`, async () => {
    await fixture(async f => {
      const request = checkRulesConnection();await settle();f.respond(response);
      await assert.rejects(request, { code: 'rules_connection_unavailable' });
      assert.equal(f.requests.length, 1);
      assert.equal(f.timers.size, 0);
    });
  });
}

test('an unanswered connection check times out without retrying requests or mutations', async () => {
  await fixture(async f => {
    const request = checkRulesConnection();await settle();f.expire();
    await assert.rejects(request, { code: 'rules_connection_timeout' });
    f.respond({ success: true, protocol: 1 });await settle();
    assert.deepEqual(f.requests, [{ type: 'rules:health' }]);
    assert.equal(f.timers.size, 0);
  });
});

test('a sender rejected by the health router stays distinguishable from a missing reply', async () => {
  await fixture(async f => {
    const request = checkRulesConnection();await settle();
    f.respond({ success: false, code: 'rules_health_forbidden', message: 'private data' });
    await assert.rejects(request, { code: 'rules_health_forbidden' });
    assert.equal(f.requests.length, 1);
  });
});

test('an invalidated extension context rejects the check and releases its timer', async () => {
  await fixture(async f => {
    await assert.rejects(checkRulesConnection(), /Extension context invalidated/);
    assert.equal(f.timers.size, 0);
    assert.equal(f.requests.length, 1);
  }, { throws: true });
});
