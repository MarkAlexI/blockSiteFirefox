import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelemetryStore,
  TELEMETRY_BUCKETS_KEY,
  TELEMETRY_DELIVERY_STATE_KEY
} from '../telemetry/telemetryStore.js';

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    setCalls: 0,
    async get(keys) {
      const result = {};
      for (const key of keys) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(values) {
      this.setCalls++;
      Object.assign(data, structuredClone(values));
    }
  };
}

test('telemetry store writes nothing before consent', async () => {
  const storage = createStorage();
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: false }),
    now: () => Date.parse('2026-08-07T12:00:00Z')
  });

  assert.equal(await store.incrementCounter('rule_created'), false);
  assert.equal(await store.recordError({ source: 'dnr', code: 'sync_failed' }), false);
  assert.equal(storage.setCalls, 0);
  assert.equal(storage.data[TELEMETRY_BUCKETS_KEY], undefined);
});

test('telemetry store aggregates counters and identical errors by UTC day', async () => {
  const storage = createStorage();
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-07T12:00:00Z')
  });

  await store.incrementCounter('rule_created');
  await store.incrementCounter('rule_created', 2);
  await store.recordError({
    source: 'dnr', code: 'sync_failed', operation: 'update_dynamic_rules', errorName: 'TypeError'
  });
  await store.recordError({
    source: 'dnr', code: 'sync_failed', operation: 'update_dynamic_rules', errorName: 'TypeError'
  });

  assert.deepEqual(await store.getPendingBatches(), [{
    date: '2026-08-07',
    counters: { rule_created: 3 },
    errors: [{
      source: 'dnr',
      code: 'sync_failed',
      operation: 'update_dynamic_rules',
      errorName: 'typeerror',
      fingerprint: 'dnr:sync_failed:update_dynamic_rules:typeerror',
      count: 2
    }]
  }]);
});

test('telemetry store never stores arbitrary counter names or error details', async () => {
  const storage = createStorage();
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-07T12:00:00Z')
  });

  assert.equal(await store.incrementCounter('https://example.com/private'), false);
  assert.equal(await store.recordError({
    source: 'worker',
    code: 'uncaught_error',
    operation: 'https://private.example/path',
    errorName: 'Error',
    message: 'secret@example.com',
    url: 'https://private.example'
  }), true);

  const serialized = JSON.stringify(storage.data[TELEMETRY_BUCKETS_KEY]);
  assert.equal(serialized.includes('private.example'), false);
  assert.equal(serialized.includes('secret@example.com'), false);
});

test('telemetry clearAll removes pending data and delivery state', async () => {
  const storage = createStorage({
    [TELEMETRY_BUCKETS_KEY]: { '2026-08-07': { date: '2026-08-07', counters: { rule_created: 1 }, errors: [] } },
    [TELEMETRY_DELIVERY_STATE_KEY]: { failureCount: 2 }
  });
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true })
  });
  await store.clearAll();
  assert.deepEqual(storage.data[TELEMETRY_BUCKETS_KEY], {});
  assert.deepEqual(storage.data[TELEMETRY_DELIVERY_STATE_KEY], {});
});

test('telemetry retention keeps only the current and previous six UTC dates', async () => {
  const storage = createStorage({
    [TELEMETRY_BUCKETS_KEY]: {
      '2026-07-31': { date: '2026-07-31', counters: { rule_created: 1 }, errors: [] },
      '2026-08-01': { date: '2026-08-01', counters: { rule_created: 1 }, errors: [] },
      '2026-08-07': { date: '2026-08-07', counters: { rule_created: 1 }, errors: [] },
      '2026-08-08': { date: '2026-08-08', counters: { rule_created: 1 }, errors: [] }
    }
  });
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-07T23:59:00Z'),
    retentionDays: 7
  });

  const batches = await store.getPendingBatches();
  assert.deepEqual(batches.map(batch => batch.date), ['2026-08-01', '2026-08-07']);
});

test('telemetry bucket captures coarse context once and keeps it for queued events', async () => {
  const storage = createStorage();
  let context = {
    extensionVersion: '4.8.1',
    browser: 'firefox',
    browserMajor: 140,
    platform: 'desktop',
    os: 'windows',
    locale: 'en-us',
    access: 'free',
    installationAge: 'lt_7d'
  };
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    getContext: async () => ({ ...context }),
    now: () => Date.parse('2026-08-10T12:00:00Z')
  });

  await store.incrementCounter('rule_created');
  context = { ...context, access: 'pro', extensionVersion: '4.8.3' };
  await store.incrementCounter('focus_started');

  const [batch] = await store.getPendingBatches();
  assert.deepEqual(batch.context, {
    extensionVersion: '4.8.1',
    browser: 'firefox',
    browserMajor: 140,
    platform: 'desktop',
    os: 'windows',
    locale: 'en-us',
    access: 'free',
    installationAge: 'lt_7d'
  });
  assert.deepEqual(batch.counters, { rule_created: 1, focus_started: 1 });
});

test('telemetry retention physically removes expired buckets from local storage', async () => {
  const storage = createStorage({
    [TELEMETRY_BUCKETS_KEY]: {
      '2026-08-01': { date: '2026-08-01', counters: { rule_created: 1 }, errors: [] },
      '2026-08-10': { date: '2026-08-10', counters: { rule_created: 1 }, errors: [] }
    }
  });
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-10T12:00:00Z'),
    retentionDays: 7
  });

  await store.getPendingBatches();
  assert.deepEqual(Object.keys(storage.data[TELEMETRY_BUCKETS_KEY]), ['2026-08-10']);
});

test('telemetry acknowledgement removes only the sent snapshot and keeps concurrent same-day events', async () => {
  const storage = createStorage({
    [TELEMETRY_BUCKETS_KEY]: {
      '2026-08-10': {
        date: '2026-08-10',
        counters: { rule_created: 3, focus_started: 1 },
        errors: [{
          source: 'rules',
          code: 'blockurl_invalid',
          operation: 'add',
          errorName: 'rulesmutationerror',
          fingerprint: 'rules:blockurl_invalid:add:rulesmutationerror',
          count: 2
        }]
      }
    }
  });
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-10T12:00:00Z')
  });

  await store.acknowledgeBatches([{
    date: '2026-08-10',
    counters: { rule_created: 2 },
    errors: [{
      source: 'rules',
      code: 'blockurl_invalid',
      operation: 'add',
      errorName: 'rulesmutationerror',
      fingerprint: 'rules:blockurl_invalid:add:rulesmutationerror',
      count: 1
    }]
  }]);

  assert.deepEqual(storage.data[TELEMETRY_BUCKETS_KEY]['2026-08-10'].counters, {
    rule_created: 1,
    focus_started: 1
  });
  assert.equal(storage.data[TELEMETRY_BUCKETS_KEY]['2026-08-10'].errors[0].count, 1);
});
