const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

export const TELEMETRY_COUNTERS = new Set([
  'rule_created',
  'rule_updated',
  'rule_deleted',
  'rule_toggled',
  'rule_pack_imported',
  'rule_pack_rules_added',
  'rules_imported',
  'rules_cleared',
  'category_toggled',
  'focus_started',
  'focus_stopped',
  'focus_completed',
  'diagnostic_report_generated'
]);

export const TELEMETRY_ERROR_SOURCES = new Set([
  'dnr',
  'permissions',
  'license',
  'rules',
  'focus',
  'storage',
  'worker',
  'options',
  'popup'
]);

export function normalizeTelemetryIdentifier(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return SAFE_IDENTIFIER.test(normalized) ? normalized : fallback;
}

export function normalizeCounterName(name) {
  const normalized = normalizeTelemetryIdentifier(name, '');
  return TELEMETRY_COUNTERS.has(normalized) ? normalized : null;
}

export function sanitizeTelemetryError({
  source,
  code,
  operation = 'unknown',
  errorName = 'Error'
} = {}) {
  const safeSource = normalizeTelemetryIdentifier(source);
  const safeCode = normalizeTelemetryIdentifier(code);
  const safeOperation = normalizeTelemetryIdentifier(operation);
  const safeErrorName = normalizeTelemetryIdentifier(errorName, 'error');

  if (!TELEMETRY_ERROR_SOURCES.has(safeSource)) return null;

  return {
    source: safeSource,
    code: safeCode,
    operation: safeOperation,
    errorName: safeErrorName,
    fingerprint: `${safeSource}:${safeCode}:${safeOperation}:${safeErrorName}`
  };
}
