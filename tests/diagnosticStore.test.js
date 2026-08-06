import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiagnosticStore,
  sanitizeDiagnosticValue,
  DIAGNOSTIC_EVENTS_KEY,
  DIAGNOSTIC_STATE_KEY
} from '../diagnostics/diagnosticStore.js';

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const result = {};
      for (const key of keys) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    }
  };
}

test('diagnostic sanitizer removes URLs, emails, keys, and sensitive fields', () => {
  const value = sanitizeDiagnosticValue({
    message: 'Failed at https://example.com/private?q=1 for me@example.com using BD-SECRET-123456',
    blockURL: 'https://private.example/path',
    passwordHash: 'hash-value',
    safeCount: 3
  });

  assert.equal(value.message.includes('example.com/private'), false);
  assert.equal(value.message.includes('me@example.com'), false);
  assert.equal(value.message.includes('BD-SECRET'), false);
  assert.equal(value.blockURL, '<redacted>');
  assert.equal(value.passwordHash, '<redacted>');
  assert.equal(value.safeCount, 3);
});

test('diagnostic events are collected only while debug mode is enabled', async () => {
  const storage = createStorage();
  let debugMode = false;
  const store = createDiagnosticStore({
    localStorage: storage,
    getSettings: async () => ({ debugMode }),
    now: () => 123
  });

  assert.equal(await store.recordEvent('error', 'dnr', 'sync_failed', { error: 'nope' }), false);
  assert.deepEqual(storage.data[DIAGNOSTIC_EVENTS_KEY], undefined);

  debugMode = true;
  assert.equal(await store.recordEvent('error', 'dnr', 'sync_failed', {
    url: 'https://example.com/private',
    error: 'failed'
  }), true);

  assert.deepEqual(storage.data[DIAGNOSTIC_EVENTS_KEY], [{
    timestamp: 123,
    level: 'error',
    source: 'dnr',
    code: 'sync_failed',
    details: {
      url: '<redacted>',
      error: 'failed'
    }
  }]);
});

test('diagnostic event buffer is capped and serialized', async () => {
  const storage = createStorage();
  let timestamp = 0;
  const store = createDiagnosticStore({
    localStorage: storage,
    getSettings: async () => ({ debugMode: true }),
    now: () => ++timestamp,
    maxEvents: 3
  });

  await Promise.all([
    store.recordEvent('info', 'test', 'one'),
    store.recordEvent('info', 'test', 'two'),
    store.recordEvent('info', 'test', 'three'),
    store.recordEvent('info', 'test', 'four')
  ]);

  assert.deepEqual(
    storage.data[DIAGNOSTIC_EVENTS_KEY].map(event => event.code),
    ['two', 'three', 'four']
  );
});

test('diagnostic state avoids redundant writes and clear removes only history', async () => {
  let setCalls = 0;
  const storage = createStorage({
    [DIAGNOSTIC_EVENTS_KEY]: [{ code: 'old' }]
  });
  const originalSet = storage.set;
  storage.set = async values => {
    setCalls++;
    await originalSet(values);
  };

  const store = createDiagnosticStore({
    localStorage: storage,
    getSettings: async () => ({ debugMode: true })
  });

  await store.updateState({ lastCheck: { success: true } });
  await store.updateState({ lastCheck: { success: true } });
  assert.equal(setCalls, 1);
  assert.deepEqual(storage.data[DIAGNOSTIC_STATE_KEY], { lastCheck: { success: true } });

  await store.clearEvents();
  assert.deepEqual(storage.data[DIAGNOSTIC_EVENTS_KEY], []);
  assert.deepEqual(storage.data[DIAGNOSTIC_STATE_KEY], { lastCheck: { success: true } });
});
