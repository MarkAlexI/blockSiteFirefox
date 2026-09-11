import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASYNC_HANDLER_OPERATIONS,
  createAsyncHandlerBoundary
} from '../telemetry/asyncHandlerBoundary.js';

test('async handler boundary exposes only the approved coarse operations', () => {
  assert.deepEqual(Object.values(ASYNC_HANDLER_OPERATIONS).sort(), [
    'daily_limit_alarm',
    'dnr_reload_message',
    'pro_status_transition',
    'startup',
    'tab_created',
    'tab_updated',
    'window_focus_changed'
  ]);
});

test('async handler boundary preserves successful results without telemetry', async () => {
  const recorded = [];
  const run = createAsyncHandlerBoundary({
    recordError: async error => recorded.push(error)
  });

  const result = await run(ASYNC_HANDLER_OPERATIONS.TAB_UPDATED, async () => 'completed');

  assert.equal(result, 'completed');
  assert.deepEqual(recorded, []);
});

test('async handler boundary converts a rejection into a fixed safe fingerprint input', async () => {
  const recorded = [];
  const logged = [];
  const run = createAsyncHandlerBoundary({
    recordError: async error => recorded.push(error),
    logger: {
      error(...args) { logged.push(args); },
      info(...args) { logged.push(args); }
    }
  });

  const privateError = new TypeError('Failed at https://private.example/ for secret@example.com');
  const result = await run(ASYNC_HANDLER_OPERATIONS.TAB_CREATED, async () => {
    throw privateError;
  });

  assert.equal(result, undefined);
  assert.deepEqual(recorded, [{
    source: 'worker',
    code: 'async_handler_failed',
    operation: 'tab_created',
    errorName: 'TypeError'
  }]);
  assert.equal(JSON.stringify(recorded).includes('private.example'), false);
  assert.equal(JSON.stringify(recorded).includes('secret@example.com'), false);
  assert.equal(logged.length, 1);
});

test('telemetry persistence failure cannot reject the protected browser handler', async () => {
  const run = createAsyncHandlerBoundary({
    recordError: async () => { throw new Error('storage unavailable'); },
    logger: { error() {}, info() {} }
  });

  await assert.doesNotReject(() => run(
    ASYNC_HANDLER_OPERATIONS.STARTUP,
    async () => { throw new Error('startup failed'); }
  ));
});

test('async handler boundary rejects operation names outside its fixed allowlist', async () => {
  const run = createAsyncHandlerBoundary({ recordError: async () => {} });

  await assert.rejects(
    () => run('visited_private_example', async () => {}),
    /Unsupported async handler operation/
  );
});
