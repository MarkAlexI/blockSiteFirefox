import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCounterName,
  sanitizeTelemetryError
} from '../telemetry/telemetrySanitizer.js';

test('telemetry accepts only allowlisted counters', () => {
  assert.equal(normalizeCounterName('rule_created'), 'rule_created');
  assert.equal(normalizeCounterName('visited_example.com'), null);
  assert.equal(normalizeCounterName('https://example.com'), null);
});

test('telemetry error sanitizer keeps identifiers only and rejects unknown sources', () => {
  assert.deepEqual(sanitizeTelemetryError({
    source: 'dnr',
    code: 'sync_failed',
    operation: 'update_dynamic_rules',
    errorName: 'TypeError'
  }), {
    source: 'dnr',
    code: 'sync_failed',
    operation: 'update_dynamic_rules',
    errorName: 'typeerror',
    fingerprint: 'dnr:sync_failed:update_dynamic_rules:typeerror'
  });

  assert.equal(sanitizeTelemetryError({
    source: 'https://private.example',
    code: 'sync_failed'
  }), null);
});

test('Firefox telemetry context remains Firefox after sanitization', async () => {
  const { sanitizeTelemetryContext } = await import('../telemetry/telemetrySanitizer.js');
  assert.deepEqual(sanitizeTelemetryContext({
    extensionVersion: '4.8.1',
    browser: 'firefox',
    browserMajor: 153,
    platform: 'mobile',
    os: 'android',
    locale: 'es-es',
    access: 'free',
    installationAge: 'lt_7d'
  }), {
    extensionVersion: '4.8.1',
    browser: 'firefox',
    browserMajor: 153,
    platform: 'mobile',
    os: 'android',
    locale: 'es-es',
    access: 'free',
    installationAge: 'lt_7d'
  });
});
