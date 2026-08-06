import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiagnosticReport,
  detectBrowserSummary,
  formatDiagnosticReportText
} from '../diagnostics/diagnosticReport.js';

test('browser summary reports family, major version, and generic platform only', () => {
  assert.deepEqual(detectBrowserSummary({
    userAgent: 'Mozilla/5.0 (Linux; Android 11; Device Model) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l'
  }), {
    name: 'Chrome',
    version: '140',
    platform: 'Android'
  });
});

test('diagnostic report sanitizes nested private data', () => {
  const report = buildDiagnosticReport({
    generatedAt: '2026-08-06T20:00:00.000Z',
    extension: { version: '4.7.0', manifestVersion: 3 },
    browser: { name: 'Chrome', version: '140', platform: 'Android' },
    capabilities: {},
    access: { isPro: true, isLegacyUser: false },
    settings: { debugMode: true, mode: 'normal', disabledCategories: [] },
    rules: { total: 2, blacklist: 2, whitelist: 0, scheduled: 1, disabledByUser: 0 },
    dnr: { currentCount: 2, expectedCount: 2, inSync: true },
    permissions: { hostAccess: true },
    focusSession: { active: false, mode: 'blacklist', hardcore: false, remainingMinutes: 0 },
    license: { licenseKey: 'BD-PRIVATE-123456', lastCheck: null },
    recentEvents: [{
      timestamp: 1,
      level: 'error',
      source: 'test',
      code: 'failed',
      details: { message: 'See https://example.com/private' }
    }]
  });

  assert.equal(report.license.licenseKey, '<redacted>');
  assert.equal(report.recentEvents[0].details.message.includes('example.com'), false);
});

test('formatted diagnostic report contains counts and structured events without rule addresses', () => {
  const text = formatDiagnosticReportText({
    generatedAt: '2026-08-06T20:00:00.000Z',
    extension: { version: '4.7.0', manifestVersion: 3 },
    browser: { name: 'Firefox', version: '141', platform: 'Android' },
    access: { isPro: true, isLegacyUser: false },
    settings: { debugMode: true, mode: 'strict', disabledCategories: ['social'] },
    rules: { total: 4, blacklist: 3, whitelist: 1, scheduled: 2, disabledByUser: 1 },
    dnr: { currentCount: 2, expectedCount: 2, inSync: true, lastResult: null },
    permissions: { hostAccess: true },
    focusSession: { active: true, mode: 'blacklist', hardcore: false, remainingMinutes: 12 },
    license: { lastCheck: null },
    recentEvents: [{ timestamp: 1, level: 'warn', source: 'license', code: 'verification_failed', details: { reason: 'timeout' } }]
  });

  assert.match(text, /Stored rules: 4/);
  assert.match(text, /DNR integrity: in sync/);
  assert.match(text, /verification_failed/);
  assert.doesNotMatch(text, /facebook\.com/);
});
