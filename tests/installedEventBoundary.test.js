import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstalledEventBoundary } from '../telemetry/installedEventBoundary.js';
import { sanitizeTelemetryError } from '../telemetry/telemetrySanitizer.js';
import { createTelemetryStore } from '../telemetry/telemetryStore.js';
import { createDiagnosticStore } from '../diagnostics/diagnosticStore.js';
import { createExtensionApi } from './helpers/extensionTestHarness.js';

const logger = { error() {}, info() {} };
const phases = ['prepare', 'initialize', 'permissions', 'dnr_integrity', 'open_install_page'];

for (const reason of ['install', 'update', 'browser_update']) {
  for (const failedPhase of phases) {
    test(`${reason}: records the failed ${failedPhase} step once and stops later steps`, async () => {
      const errors = [];
      const diagnostics = [];
      const run = createInstalledEventBoundary({
        recordError: error => errors.push(sanitizeTelemetryError(error)),
        recordDiagnostic: detail => diagnostics.push(detail),
        logger
      });
      const visited = [];
      const result = await run(reason, async step => {
        for (const phase of phases) {
          await step(phase, () => {
            visited.push(phase);
            if (phase === failedPhase) {
              throw new TypeError('secret@example.com https://private.example/ BD-PRO-PRIVATE123');
            }
          });
        }
        return 'unexpected';
      });
      const index = phases.indexOf(failedPhase);
      assert.equal(result, undefined);
      assert.deepEqual(visited, phases.slice(0, index + 1));
      assert.deepEqual(errors, [{
        source: 'worker', code: `lifecycle_${failedPhase}_failed`, operation: reason,
        errorName: 'typeerror',
        fingerprint: `worker:lifecycle_${failedPhase}_failed:${reason}:typeerror`
      }]);
      assert.deepEqual(diagnostics, [{
        code: `lifecycle_${failedPhase}_failed`, reason, phase: failedPhase,
        errorName: 'TypeError', completedPhases: phases.slice(0, index)
      }]);
      assert.doesNotMatch(JSON.stringify({ errors, diagnostics }), /secret|private|BD-PRO/);
    });
  }
}

test('successful lifecycle preserves ordered results without recording an error', async () => {
  const run = createInstalledEventBoundary({
    recordError() { assert.fail('success is not a failure'); },
    recordDiagnostic() { assert.fail('success needs no failure history'); },
    logger
  });
  const visited = [];
  assert.equal(await run('install', async step => {
    for (const phase of phases) {
      assert.equal(await step(phase, () => { visited.push(phase); return phase; }), phase);
    }
    return 'ready';
  }), 'ready');
  assert.deepEqual(visited, phases);
});

test('unknown reasons, phases and custom error names cannot enter the reports', async () => {
  const errors = [];
  const diagnostics = [];
  const run = createInstalledEventBoundary({
    recordError: error => errors.push(error), recordDiagnostic: value => diagnostics.push(value), logger
  });
  await run('private_account_name', async step => step('private_url', () => assert.fail()));
  await run('private_account_name', async () => {
    const error = new Error('private message');
    error.name = 'private_account_name';
    throw error;
  });
  assert.deepEqual(errors.map(error => [error.operation, error.code, error.errorName]), [
    ['unknown', 'lifecycle_prepare_failed', 'TypeError'],
    ['unknown', 'lifecycle_prepare_failed', 'Error']
  ]);
  assert.doesNotMatch(JSON.stringify({ errors, diagnostics }), /private/);
});

test('both reporters run independently even when persistence throws synchronously', async () => {
  const visited = [];
  const run = createInstalledEventBoundary({
    recordError() { visited.push('telemetry'); throw new Error('storage unavailable'); },
    recordDiagnostic() { visited.push('diagnostic'); throw new Error('history unavailable'); },
    logger
  });
  await assert.doesNotReject(() => run('install', async step =>
    step('open_install_page', () => { throw new Error('tab unavailable'); })
  ));
  assert.deepEqual(visited, ['telemetry', 'diagnostic']);
});

for (const [consent, debug] of [[false, false], [false, true], [true, false], [true, true]]) {
  test(`telemetry consent=${consent}, local debug=${debug} retain separate gates`, async () => {
    const api = createExtensionApi();
    const telemetry = createTelemetryStore({
      localStorage: api.storage.local,
      getConsent: async () => ({ enabled: consent }),
      getContext: async () => ({ extensionVersion: '5.3.24' })
    });
    const history = createDiagnosticStore({
      localStorage: api.storage.local, getSettings: async () => ({ debugMode: debug })
    });
    const run = createInstalledEventBoundary({
      recordError: error => telemetry.recordError(error),
      recordDiagnostic: ({ code, ...details }) => history.recordEvent('error', 'worker', code, details),
      logger
    });
    await run('install', async step =>
      step('open_install_page', () => { throw new TypeError('https://private.example/'); })
    );
    const buckets = Object.values(api.storage.local.data.telemetryBuckets || {});
    assert.equal(buckets.flatMap(bucket => bucket.errors).length, consent ? 1 : 0);
    assert.equal((await history.getSnapshot()).events.length, debug ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(api.storage.local.data), /private\.example/);
  });
}
