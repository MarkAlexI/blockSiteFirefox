import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTelemetryContext } from '../telemetry/telemetryContext.js';

test('telemetry context exposes coarse technical fields without a persistent identifier', () => {
  const context = buildTelemetryContext({
    manifest: { version: '4.8.0' },
    navigatorRef: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0',
      platform: 'Win32',
      userAgentData: { mobile: false }
    },
    locale: 'uk_UA',
    isPro: true,
    installationDate: '2026-05-01T00:00:00.000Z',
    now: Date.parse('2026-08-07T00:00:00.000Z')
  });

  assert.deepEqual(context, {
    extensionVersion: '4.8.0',
    browser: 'firefox',
    browserMajor: 141,
    platform: 'desktop',
    os: 'windows',
    locale: 'uk-ua',
    access: 'pro',
    installationAge: '90d_plus'
  });
  assert.equal('id' in context, false);
  assert.equal('installationId' in context, false);
});


test('release build keeps the plain manifest version in telemetry', () => {
  const context = buildTelemetryContext({
    manifest: { version: '5.0.0' },
    navigatorRef: {},
    installationDate: null
  });
  assert.equal(context.extensionVersion, '5.0.0');
});
