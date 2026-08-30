import { RULE_PACK_TELEMETRY_COUNTERS } from './telemetryRulePack.js';

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

const TELEMETRY_BROWSERS = new Set(['firefox']);
const TELEMETRY_PLATFORMS = new Set(['desktop', 'mobile']);
const TELEMETRY_OSES = new Set(['windows', 'android', 'chromeos', 'macos', 'linux', 'other']);
const TELEMETRY_ACCESS = new Set(['free', 'pro', 'legacy']);
const TELEMETRY_INSTALLATION_AGES = new Set(['lt_7d', '7_30d', '31_90d', '90d_plus', 'unknown']);

function safeEnum(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

export function sanitizeTelemetryContext(context = {}) {
  const version = String(context.extensionVersion || 'unknown').trim().slice(0, 24);
  const browserMajor = Number(context.browserMajor);
  const locale = String(context.locale || 'en')
    .trim()
    .toLowerCase()
    .replace('_', '-')
    .slice(0, 16);

  return {
    extensionVersion: /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][a-z0-9.-]+)?$/i.test(version) ? version : 'unknown',
    browser: safeEnum(context.browser, TELEMETRY_BROWSERS, 'firefox'),
    browserMajor: Number.isInteger(browserMajor) && browserMajor > 0 && browserMajor < 1000 ? browserMajor : null,
    platform: safeEnum(context.platform, TELEMETRY_PLATFORMS, 'desktop'),
    os: safeEnum(context.os, TELEMETRY_OSES, 'other'),
    locale: /^[a-z0-9-]{1,16}$/.test(locale) ? locale : 'en',
    access: safeEnum(context.access, TELEMETRY_ACCESS, 'free'),
    installationAge: safeEnum(context.installationAge, TELEMETRY_INSTALLATION_AGES, 'unknown')
  };
}

export const TELEMETRY_COUNTERS = new Set([
  'rule_created',
  'rule_updated',
  'rule_deleted',
  'rule_toggled',
  ...RULE_PACK_TELEMETRY_COUNTERS,
  'rules_imported',
  'rules_cleared',
  'category_toggled',
  'rule_list_created',
  'rule_list_activated',
  'daily_limit_configured',
  'free_rule_limit_reached',
  'focus_started',
  'focus_stopped',
  'focus_completed',
  'diagnostic_report_generated',
  'feedback_prompt_shown',
  'feedback_review_clicked',
  'feedback_support_clicked',
  'feedback_dismissed'
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
