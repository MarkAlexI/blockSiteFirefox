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

test('new errors beyond the daily fingerprint cap do not rewrite telemetry storage', async () => {
  const storage = createStorage();
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-22T12:00:00Z'),
    maxErrorsPerDay: 1
  });

  assert.equal(await store.recordError({
    source: 'dnr',
    code: 'sync_failed',
    operation: 'update_dynamic_rules'
  }), true);
  assert.equal(storage.setCalls, 1);

  assert.equal(await store.recordError({
    source: 'rules',
    code: 'quota_exceeded',
    operation: 'add'
  }), false);
  assert.equal(storage.setCalls, 1);

  assert.equal(await store.recordError({
    source: 'dnr',
    code: 'sync_failed',
    operation: 'update_dynamic_rules'
  }), true);
  assert.equal(storage.setCalls, 2);
  assert.equal(
    storage.data[TELEMETRY_BUCKETS_KEY]['2026-08-22'].errors[0].count,
    2
  );
});

test('a capped telemetry error still removes expired buckets when retention changes', async () => {
  const storage = createStorage({
    [TELEMETRY_BUCKETS_KEY]: {
      '2026-08-01': {
        date: '2026-08-01',
        counters: { rule_created: 1 },
        errors: []
      },
      '2026-08-22': {
        date: '2026-08-22',
        counters: {},
        errors: [{
          source: 'dnr',
          code: 'sync_failed',
          operation: 'unknown',
          errorName: 'error',
          fingerprint: 'dnr:sync_failed:unknown:error',
          count: 1
        }]
      }
    }
  });
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-22T12:00:00Z'),
    maxErrorsPerDay: 1
  });

  assert.equal(await store.recordError({
    source: 'rules',
    code: 'quota_exceeded'
  }), false);
  assert.equal(storage.setCalls, 1);
  assert.deepEqual(Object.keys(storage.data[TELEMETRY_BUCKETS_KEY]), ['2026-08-22']);
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


test('prepared delivery snapshot keeps a stable ID across retries and excludes later same-day events', async () => {
  const storage = createStorage();
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
  ];
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-12T12:00:00Z'),
    createDeliveryId: () => ids.shift()
  });

  await store.incrementCounter('rule_created', 2);
  const [first] = await store.preparePendingBatches();
  assert.equal(first.deliveryId, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(first.counters, { rule_created: 2 });

  await store.incrementCounter('rule_created', 1);
  await store.incrementCounter('focus_started', 1);

  const [retry] = await store.preparePendingBatches();
  assert.equal(retry.deliveryId, first.deliveryId);
  assert.deepEqual(retry.counters, { rule_created: 2 });

  await store.acknowledgeBatches([first]);
  const [next] = await store.preparePendingBatches();
  assert.equal(next.deliveryId, '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(next.counters, { rule_created: 1, focus_started: 1 });
});

test('acknowledgement with a stale delivery ID cannot remove a newer snapshot', async () => {
  const storage = createStorage();
  const store = createTelemetryStore({
    localStorage: storage,
    getConsent: async () => ({ enabled: true }),
    now: () => Date.parse('2026-08-12T12:00:00Z'),
    createDeliveryId: () => '33333333-3333-4333-8333-333333333333'
  });

  await store.incrementCounter('rule_created');
  const [prepared] = await store.preparePendingBatches();

  await store.acknowledgeBatches([{
    ...prepared,
    deliveryId: '44444444-4444-4444-8444-444444444444'
  }]);

  const [stillPending] = await store.preparePendingBatches();
  assert.equal(stillPending.deliveryId, prepared.deliveryId);
  assert.deepEqual(stillPending.counters, { rule_created: 1 });
});
