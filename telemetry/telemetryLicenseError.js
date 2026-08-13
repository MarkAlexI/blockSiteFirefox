/**
 * Returns whether a failed license check represents an unexpected extension
 * reliability failure that should be included in remote technical telemetry.
 *
 * Expected connectivity/backend availability problems stay in local
 * diagnostics but do not count against extension reliability metrics.
 */
export function shouldRecordLicenseReliabilityError(result) {
  if (!result || result.success !== false) return false;

  const reason = typeof result.reason === 'string' ? result.reason : '';
  if (reason === 'no_key' || reason === 'temporary_failure') return false;

  return true;
}
