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
  let deliverySequence = 0;
  const nextDeliveryId = () => {
    deliverySequence += 1;
    return `00000000-0000-4000-8000-${String(deliverySequence).padStart(12, '0')}`;
  };
  return {
    async getPendingBatches() { return structuredClone(pending); },
    async preparePendingBatches() {
      pending = pending.map(batch => batch.deliveryId ? batch : {
        ...batch,
        deliveryId: nextDeliveryId()
      });
      return structuredClone(pending);
    },
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
    getContext: async () => ({ extensionVersion: '4.8.0', browser: 'firefox' }),
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
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.sentAt, '2026-08-07T12:00:00.000Z');
  assert.deepEqual(payload.context, {
    extensionVersion: '4.8.0',
    browser: 'firefox',
    browserMajor: null,
    platform: 'desktop',
    os: 'other',
    locale: 'en',
    access: 'free',
    installationAge: 'unknown'
  });
  assert.deepEqual(payload.batches, [{
    date: '2026-08-07',
    deliveryId: '00000000-0000-4000-8000-000000000001',
    counters: { rule_created: 1 },
    errors: []
  }]);
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

test('telemetry client preserves bucket context by sending separate compatible requests', async () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  const storage = createStorage({
    [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: now - 1000 }
  });
  const store = createStore([
    {
      date: '2026-08-09',
      context: {
        extensionVersion: '4.8.0', browser: 'firefox', browserMajor: 140,
        platform: 'desktop', os: 'windows', locale: 'en-us', access: 'free', installationAge: 'lt_7d'
      },
      counters: { rule_created: 1 }, errors: []
    },
    {
      date: '2026-08-10',
      context: {
        extensionVersion: '4.8.1', browser: 'firefox', browserMajor: 140,
        platform: 'desktop', os: 'windows', locale: 'en-us', access: 'pro', installationAge: 'lt_7d'
      },
      counters: { focus_started: 1 }, errors: []
    }
  ]);
  const requests = [];
  const client = createTelemetryClient({
    localStorage: storage,
    store,
    getContext: async () => ({
      extensionVersion: '4.8.1', browser: 'firefox', browserMajor: 140,
      platform: 'desktop', os: 'windows', locale: 'en-us', access: 'pro', installationAge: 'lt_7d'
    }),
    now: () => now,
    fetchFn: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    }
  });

  const result = await client.flush();
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].context.extensionVersion, '4.8.0');
  assert.equal(requests[0].context.access, 'free');
  assert.deepEqual(requests[0].batches.map(batch => batch.date), ['2026-08-09']);
  assert.equal('context' in requests[0].batches[0], false);
  assert.equal(requests[1].context.extensionVersion, '4.8.1');
  assert.equal(requests[1].context.access, 'pro');
  assert.deepEqual(requests[1].batches.map(batch => batch.date), ['2026-08-10']);
});

test('telemetry delivery failure schedules a real retry and success cancels it', async () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  const storage = createStorage({
    [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: now - 1000 }
  });
  const store = createStore([{ date: '2026-08-10', counters: { rule_created: 1 }, errors: [] }]);
  const scheduled = [];
  let cancelled = 0;
  let shouldFail = true;
  const client = createTelemetryClient({
    localStorage: storage,
    store,
    getContext: async () => ({ extensionVersion: '4.8.1', browser: 'firefox' }),
    now: () => now,
    scheduleRetry: async when => { scheduled.push(when); },
    cancelRetry: async () => { cancelled++; },
    fetchFn: async () => shouldFail ?
      { ok: false, status: 503, json: async () => ({}) } :
      { ok: true, status: 202, json: async () => ({ ok: true }) }
  });

  const failed = await client.flush();
  assert.equal(failed.success, false);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0], now + 60 * 60 * 1000);

  shouldFail = false;
  const succeeded = await client.flush({ force: true });
  assert.equal(succeeded.success, true);
  assert.equal(cancelled, 1);
});

test('telemetry retry schedule is restored from delivery state', async () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  const storage = createStorage({
    [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: now - 1000 }
  });
  const store = createStore([]);
  await store.setDeliveryState({ nextAttemptAt: now - 1000, failureCount: 2 });
  const scheduled = [];
  const client = createTelemetryClient({
    localStorage: storage,
    store,
    getContext: async () => ({}),
    now: () => now,
    scheduleRetry: async when => { scheduled.push(when); }
  });

  assert.equal(await client.restoreRetry(), true);
  assert.deepEqual(scheduled, [now + 60 * 1000]);
});


test('telemetry client retries the same prepared delivery ID after a failed request', async () => {
  const now = Date.parse('2026-08-12T12:00:00.000Z');
  const storage = createStorage({
    [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: now - 1000 }
  });
  const store = createStore([{
    date: '2026-08-12', counters: { rule_created: 1 }, errors: []
  }]);
  const ids = [];
  let fail = true;
  const client = createTelemetryClient({
    localStorage: storage,
    store,
    getContext: async () => ({ extensionVersion: '4.8.4', browser: 'firefox' }),
    now: () => now,
    fetchFn: async (_url, options) => {
      ids.push(JSON.parse(options.body).batches[0].deliveryId);
      return fail ?
        { ok: false, status: 503, json: async () => ({}) } :
        { ok: true, status: 202, json: async () => ({ ok: true }) };
    }
  });

  assert.equal((await client.flush()).success, false);
  fail = false;
  assert.equal((await client.flush({ force: true })).success, true);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});
