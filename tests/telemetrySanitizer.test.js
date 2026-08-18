import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCounterName,
  sanitizeTelemetryError
} from '../telemetry/telemetrySanitizer.js';

test('telemetry accepts only allowlisted counters', () => {
  assert.equal(normalizeCounterName('rule_created'), 'rule_created');
  assert.equal(normalizeCounterName('feedback_prompt_shown'), 'feedback_prompt_shown');
  assert.equal(normalizeCounterName('feedback_review_clicked'), 'feedback_review_clicked');
  assert.equal(normalizeCounterName('feedback_support_clicked'), 'feedback_support_clicked');
  assert.equal(normalizeCounterName('feedback_dismissed'), 'feedback_dismissed');
  assert.equal(normalizeCounterName('feedback_private_value'), null);
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


test('RC build versions survive telemetry context sanitization', async () => {
  const { sanitizeTelemetryContext } = await import('../telemetry/telemetrySanitizer.js');
  const sanitized = sanitizeTelemetryContext({
    extensionVersion: '5.0.0',
    browser: 'chrome',
    browserMajor: 137,
    platform: 'mobile',
    os: 'android',
    locale: 'en-us',
    access: 'pro',
    installationAge: 'lt_7d'
  });

  assert.equal(sanitized.extensionVersion, '5.0.0');
});
