import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeTelemetryError, normalizeTelemetryOperation } from '../telemetry/telemetrySanitizer.js';
import { createTelemetryStore } from '../telemetry/telemetryStore.js';
import { createTelemetryClient } from '../telemetry/telemetryClient.js';
import { TELEMETRY_CONSENT_KEY } from '../telemetry/telemetryConsent.js';
import { IS_FIREFOX } from '../utils/constants.js';

const base = { source: 'worker', code: 'uncaught_error', operation: 'service_worker', errorName: 'TypeError' };
const location = { module: 'scripts_service_worker', line: 2330 };
const fingerprint = 'worker:uncaught_error:service_worker:typeerror:at:scripts_service_worker:2330';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('own source locations survive sanitization and separate otherwise identical errors', () => {
  const first = sanitizeTelemetryError({ ...base, location });
  assert.deepEqual(first.location, location);
  assert.equal(first.fingerprint, fingerprint);
  const second = sanitizeTelemetryError({ ...base, location: { ...location, line: 2331 } });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(sanitizeTelemetryError(base).fingerprint, 'worker:uncaught_error:service_worker:typeerror');
});

test('only a bounded own module and integer source line can enter a global worker fingerprint', () => {
  for (const bad of [null, [], {}, { ...location, module: 'https://private.invalid/path' },
    { ...location, module: 'unknown_module' }, { ...location, line: 0 }, { ...location, line: 100001 },
    { ...location, line: 1.5 }, { ...location, line: '2330' }, { ...location, url: 'secret' }]) {
    const result = sanitizeTelemetryError({ ...base, location: bad });
    assert.equal(result.location, undefined);
    assert.equal(result.fingerprint, 'worker:uncaught_error:service_worker:typeerror');
  }
  assert.equal(sanitizeTelemetryError({ ...base, source: 'options', location }).location, undefined);
  assert.equal(sanitizeTelemetryError({ ...base, code: 'async_handler_failed', location }).location, undefined);
  assert.equal(sanitizeTelemetryError({ ...base, operation: 'tab_updated', location }).location, undefined);
});

test('close and statistics message failures have distinct approved operations', async () => {
  const { ASYNC_HANDLER_OPERATIONS: ops, createAsyncHandlerBoundary } = await import('../telemetry/asyncHandlerBoundary.js');
  const records = [];
  const run = createAsyncHandlerBoundary({ recordError: async e => records.push(sanitizeTelemetryError(e)),
    logger: { error() {}, info() {} } });
  for (const [key, expected] of [['CLOSE_CURRENT_TAB','close_current_tab'],['RECORD_BLOCK','record_block'],['RECORD_REDIRECT','record_redirect']]) {
    assert.equal(ops[key], expected);
    assert.equal(normalizeTelemetryOperation(expected), expected);
    await run(ops[key], async () => { throw new Error('synthetic refusal'); });
  }
  assert.equal(new Set(records.map(r => r.fingerprint)).size, 3);
});

test('global ErrorEvent provenance requires an exact own module URL and never sends URLs or messages', async () => {
  const { installWorkerErrorReporting } = await import('../telemetry/workerErrorReporter.js');
  const listeners = new Map(), records = [];
  const runtime = { getURL: p => 'moz-extension://owned-id/' + p };
  const target = { addEventListener: (n, fn) => listeners.set(n, fn), removeEventListener: n => listeners.delete(n) };
  const stop = installWorkerErrorReporting({ globalRef: target, runtime, recordError: async e => records.push(sanitizeTelemetryError(e)) });
  const event = { error: { name: 'TypeError', message: 'secret@example.invalid', stack: 'private stack' },
    filename: runtime.getURL('scripts/service_worker.js'), lineno: 2330 };
  listeners.get('error')(event); await tick();
  assert.equal(records[0].fingerprint, fingerprint);
  for (const filename of ['https://private.invalid/scripts/service_worker.js',
    'moz-extension://other-id/scripts/service_worker.js',
    runtime.getURL('scripts/service_worker.js?private=1'), runtime.getURL('scripts/service_worker.js#private'),
    runtime.getURL('unknown.js')]) {
    listeners.get('error')({ ...event, filename }); await tick();
    assert.equal(records.at(-1).location, undefined);
  }
  listeners.get('unhandledrejection')({ reason: event.error }); await tick();
  assert.equal(records.at(-1).code, 'unhandled_rejection');
  assert.equal(records.at(-1).location, undefined);
  const wire = JSON.stringify(records);
  for (const secret of ['owned-id','private.invalid','secret@','private stack','filename','message']) assert.equal(wire.includes(secret), false);
  stop(); assert.equal(listeners.size, 0);
});

test('failed recording cannot recursively throw from a global error handler', async () => {
  const { installWorkerErrorReporting } = await import('../telemetry/workerErrorReporter.js');
  for (const recordError of [() => { throw new Error('sync refusal'); }, async () => { throw new Error('async refusal'); }]) {
    let handler, reported = 0;
    installWorkerErrorReporting({ globalRef: { addEventListener(name, fn) { if (name === 'error') handler = fn; } },
      runtime: { getURL: p => 'chrome-extension://owned/' + p }, recordError, logger: { info() { reported++; } } });
    assert.doesNotThrow(() => handler({ error: new TypeError(), filename: '', lineno: 0 }));
    await tick(); assert.equal(reported, 1);
  }
});

test('the fixed source catalog covers every module imported by the real background entry', async () => {
  const { WORKER_ERROR_MODULES } = await import('../telemetry/errorLocation.js');
  const root = fileURLToPath(new URL('../', import.meta.url)), seen = new Set(), todo = ['scripts/service_worker.js'];
  while (todo.length) {
    const relative = todo.pop(); if (seen.has(relative)) continue; seen.add(relative);
    assert.ok(Object.hasOwn(WORKER_ERROR_MODULES, relative), relative);
    const source = await readFile(path.join(root, relative), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+\.js)['"]/g)) {
      todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
    }
  }
  assert.equal(new Set(Object.values(WORKER_ERROR_MODULES)).size, Object.keys(WORKER_ERROR_MODULES).length);
});

test('real store and client preserve location, old errors and the delivery snapshot through a retry', async () => {
  const now = Date.parse('2026-10-27T12:00:00Z'), date = '2026-10-27';
  const data = { [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: now - 1000 } };
  const localStorage = { async get(keys) { return Object.fromEntries(keys.map(k => [k, structuredClone(data[k])])); },
    async set(values) { Object.assign(data, structuredClone(values)); } };
  const context = { extensionVersion: '5.5.2', browser: IS_FIREFOX ? 'firefox' : 'chrome' };
  const store = createTelemetryStore({ localStorage, getConsent: async () => ({ enabled: true }),
    getContext: async () => context, now: () => now, createDeliveryId: () => '11111111-1111-4111-8111-111111111111' });
  await store.recordError({ ...base, location }); await store.recordError(base);
  const requests = [];
  const client = createTelemetryClient({ localStorage, store, getContext: async () => context, now: () => now,
    fetchFn: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1 ? { ok: false, status: 503 } : { ok: true, status: 202,
        json: async () => ({ ok: true, acceptedDates: [date] }) };
    } });
  assert.equal((await client.flush({ force: true })).success, false);
  assert.equal((await client.flush({ force: true })).success, true);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].schemaVersion, 3);
  assert.deepEqual(requests[0].batches[0].errors[0].location, location);
  assert.equal(requests[0].batches[0].errors[0].fingerprint, fingerprint);
  assert.equal(requests[0].batches[0].errors[1].location, undefined);
  assert.deepEqual(await store.getPendingBatches(), []);
});
