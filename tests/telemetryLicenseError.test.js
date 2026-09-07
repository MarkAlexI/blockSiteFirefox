import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecordLicenseReliabilityError } from '../telemetry/telemetryLicenseError.js';

test('transient license verification failures are excluded from reliability errors', () => {
  assert.equal(shouldRecordLicenseReliabilityError({
    success: false,
    reason: 'temporary_failure'
  }), false);

  assert.equal(shouldRecordLicenseReliabilityError({
    success: false,
    reason: 'no_key'
  }), false);

  assert.equal(shouldRecordLicenseReliabilityError({
    success: false,
    reason: 'consent_required'
  }), false);
});

test('unexpected license-check failures remain eligible for reliability errors', () => {
  assert.equal(shouldRecordLicenseReliabilityError({
    success: false,
    reason: 'unexpected_failure'
  }), true);

  assert.equal(shouldRecordLicenseReliabilityError({
    success: true,
    reason: 'verified'
  }), false);
});
