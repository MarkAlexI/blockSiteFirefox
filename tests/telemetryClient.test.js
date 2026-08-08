import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryClient } from '../telemetry/telemetryClient.js';
import { TELEMETRY_CONSENT_KEY } from '../telemetry/telemetryConsent.js';

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const result = {};
      for (const key of keys) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(values) { Object.assign(data, structuredClone(values)); }
  };
}

function createStore(batches = []) {
  let pending = structuredClone(batches);
  let delivery = {};
  let clearedAll = 0;
  return {
    async getPendingBatches() { return structuredClone(pending); },
    async clearDates(dates) { pending = pending.filter(batch => !dates.includes(batch.date)); },
    async clearAll() { pending = []; delivery = {}; clearedAll++; },
    async getDeliveryState() { return { ...delivery }; },
    async setDeliveryState(value) { delivery = { ...value }; },
    snapshot: () => ({ pending, delivery, clearedAll })
  };
}

test('telemetry client never sends without explicit consent', async () => {
  const storage = createStorage();
  const store = createStore([{ date: '2026-08-07', counters: { rule_created: 1 }, errors: [] }]);
  let fetchCalls = 0;
  const client = createTelemetryClient({
    localStorage: storage,
    store,
    getContext: async () => ({}),
    fetchFn: async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  });

  assert.deepEqual(await client.flush(), { success: true, sent: false, reason: 'disabled' });
  assert.equal(fetchCalls, 0);
});

test('telemetry client sends the versioned batch contract and clears accepted dates', async () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const storage = createStorage({
    [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: now - 1000 }
  });
  const store = createStore([{ date: '2026-08-07', counters: { rule_created: 1 }, errors: [] }]);
  let request = null;
  const client = createTelemetryClient({
    localStorage: storage,
    store,
    getContext: async () => ({ extensionVersion: '4.8.0', browser: 'chrome' }),
    now: () => now,
    fetchFn: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    }
  });

  const result = await client.flush();
  assert.equal(result.success, true);
  assert.equal(result.sent, true);
  assert.equal(request.url, 'https://blockdistraction.com/api/telemetry');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.sentAt, '2026-08-07T12:00:00.000Z');
  assert.deepEqual(payload.context, { extensionVersion: '4.8.0', browser: 'chrome' });
  assert.deepEqual(payload.batches, [{ date: '2026-08-07', counters: { rule_created: 1 }, errors: [] }]);
  assert.deepEqual(store.snapshot().pending, []);
});

test('telemetry client retains data and applies backoff after missing server endpoint', async () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const storage = createStorage({
    [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: now - 1000 }
  });
  const store = createStore([{ date: '2026-08-07', counters: { rule_created: 1 }, errors: [] }]);
  let fetchCalls = 0;
  const client = createTelemetryClient({
    localStorage: storage,
    store,
    getContext: async () => ({}),
    now: () => now,
    fetchFn: async () => {
      fetchCalls++;
      return { ok: false, status: 404, json: async () => ({}) };
    }
  });

  const first = await client.flush();
  assert.equal(first.success, false);
  assert.equal(first.status, 404);
  assert.equal(store.snapshot().pending.length, 1);
  assert.equal(store.snapshot().delivery.failureCount, 1);
  assert.equal(store.snapshot().delivery.nextAttemptAt > now, true);

  const second = await client.flush();
  assert.equal(second.reason, 'backoff');
  assert.equal(fetchCalls, 1);
});

test('turning telemetry off clears all pending telemetry data', async () => {
  const storage = createStorage();
  const store = createStore([{ date: '2026-08-07', counters: { rule_created: 1 }, errors: [] }]);
  const client = createTelemetryClient({
    localStorage: storage,
    store,
    getContext: async () => ({}),
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  });

  await client.setConsent(true);
  await client.setConsent(false);
  assert.equal(store.snapshot().clearedAll, 1);
  assert.equal((await client.getConsent()).enabled, false);
});
