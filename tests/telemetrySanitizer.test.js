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
