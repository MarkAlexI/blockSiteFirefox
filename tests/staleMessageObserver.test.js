import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observe } from '../e2e/stale-scenarios.mjs';

async function setup(native, { alias = false, browserOnly = false } = {}) {
  const api = { runtime: { sendMessage: native } };
  const context = vm.createContext({ window: {}, structuredClone,
    ...(browserOnly ? {} : { chrome: api }),
    ...(alias || browserOnly ? { browser: api } : {}) });
  await observe({ evaluate: fn => vm.runInContext(`(${fn.toString()})()`, context) });
  return { api, events: context.window.__bdStale };
}

for (const alias of [false, true]) {
  test(`observer preserves callback transport with browser alias=${alias}`, async () => {
    const response = { success: true };
    let complete, count = 0, callbackResponse;
    const { api, events } = await setup((input, callback) => {
      count++; complete = () => callback(response); return undefined;
    }, { alias });
    assert.equal(api.runtime.sendMessage({ type: 'focus_schedule_get' }, value => {
      assert.equal(events.pendingGets, 0);
      callbackResponse = value;
    }), undefined);
    assert.equal(events.pendingGets, 1);
    complete();
    assert.equal(callbackResponse, response);
    assert.equal(events.calls[0].response, response);
    assert.equal(events.calls[0].completed, true);
    assert.equal(count, 1);
  });
}

for (const browserOnly of [false, true]) {
  test(`observer preserves Promise transport with browserOnly=${browserOnly}`, async () => {
    const response = { success: true };
    let resolve, count = 0;
    const { api, events } = await setup(() => {
      count++; return new Promise(done => { resolve = done; });
    }, { browserOnly });
    const pending = api.runtime.sendMessage({ type: 'focus_schedule_get' });
    assert.equal(events.pendingGets, 1);
    resolve(response);
    assert.equal(await pending, response);
    assert.equal(events.calls[0].completed, true);
    assert.equal(events.pendingGets, 0);
    assert.equal(count, 1);
  });
}

test('observer propagates Promise rejection and balances pending reads', async () => {
  const error = new Error('channel closed');
  const { api, events } = await setup(() => Promise.reject(error), { browserOnly: true });
  await assert.rejects(api.runtime.sendMessage({ type: 'focus_schedule_get' }), value => value === error);
  assert.equal(events.pendingGets, 0);
  assert.equal(events.calls[0].completed, true);
});

test('observer propagates synchronous transport errors without retrying', async () => {
  const error = new Error('invalid arguments');
  let count = 0;
  const { api, events } = await setup(() => { count++; throw error; }, { alias: true });
  assert.throws(() => api.runtime.sendMessage({ type: 'focus_schedule_get' }), value => value === error);
  assert.equal(count, 1);
  assert.equal(events.pendingGets, 0);
  assert.equal(events.calls[0].completed, true);
});

test('observer forwards untracked calls and native return unchanged', async () => {
  const result = {};
  const input = { type: 'rules:add' };
  let count = 0;
  const { api, events } = await setup(message => {
    count++; assert.equal(message, input); return result;
  }, { alias: true });
  assert.equal(api.runtime.sendMessage(input), result);
  assert.equal(count, 1);
  assert.equal(events.calls.length, 0);
  assert.equal(events.pendingGets, 0);
});
