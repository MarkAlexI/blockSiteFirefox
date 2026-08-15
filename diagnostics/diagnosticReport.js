import { sanitizeDiagnosticValue } from './diagnosticStore.js';

export const DIAGNOSTIC_REPORT_SCHEMA_VERSION = 1;

export function detectBrowserSummary({ userAgent = '', userAgentData = null, platform = '' } = {}) {
  const ua = String(userAgent || '');
  const brands = Array.isArray(userAgentData?.brands) ? userAgentData.brands : [];
  let name = 'Unknown';
  let version = null;

  const brand = brands.find(item =>
    /Edge|Chrome|Chromium|Firefox|Opera/i.test(item.brand) &&
    !/Not.A.Brand/i.test(item.brand)
  );

  if (brand) {
    name = brand.brand.replace('Microsoft Edge', 'Edge').replace('Google Chrome', 'Chrome');
    version = String(brand.version || '').split('.')[0] || null;
  } else {
    const patterns = [
      ['Edge', /EdgA?\/([\d.]+)/],
      ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
      ['Firefox', /Firefox\/([\d.]+)/],
      ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
      ['Safari', /Version\/([\d.]+).*Safari/]
    ];

    for (const [candidate, pattern] of patterns) {
      const match = ua.match(pattern);
      if (match) {
        name = candidate;
        version = match[1].split('.')[0];
        break;
      }
    }
  }

  const platformSource = `${userAgentData?.platform || ''} ${platform || ''} ${ua}`;
  let platformName = 'Unknown';
  if (/Android/i.test(platformSource)) platformName = 'Android';
  else if (/Windows/i.test(platformSource)) platformName = 'Windows';
  else if (/iPhone|iPad|iPod|iOS/i.test(platformSource)) platformName = 'iOS';
  else if (/Mac/i.test(platformSource)) platformName = 'macOS';
  else if (/Linux/i.test(platformSource)) platformName = 'Linux';

  return { name, version, platform: platformName };
}

export function buildDiagnosticReport(data) {
  return sanitizeDiagnosticValue({
    schemaVersion: DIAGNOSTIC_REPORT_SCHEMA_VERSION,
    generatedAt: data.generatedAt,
    extension: data.extension,
    browser: data.browser,
    capabilities: data.capabilities,
    access: data.access,
    settings: data.settings,
    rules: data.rules,
    dnr: data.dnr,
    permissions: data.permissions,
    focusSession: data.focusSession,
    dailyLimits: data.dailyLimits,
    license: data.license,
    telemetry: data.telemetry,
    recentEvents: Array.isArray(data.recentEvents) ? data.recentEvents : []
  });
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function formatTimestamp(value) {
  if (!value) return 'not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function formatDiagnosticReportText(report) {
  const browserVersion = report.browser?.version ? ` ${report.browser.version}` : '';
  const dnrStatus = report.dnr?.inSync === true ? 'in sync' :
    report.dnr?.inSync === false ? 'out of sync' : 'unknown';
  const focus = report.focusSession || {};
  const lines = [
    'BlockDistraction Diagnostic Report',
    `Generated: ${formatTimestamp(report.generatedAt)}`,
    '',
    '[Extension]',
    `Version: ${report.extension?.version || 'unknown'}`,
    `Manifest: ${report.extension?.manifestVersion || 'unknown'}`,
    `Browser: ${report.browser?.name || 'Unknown'}${browserVersion}`,
    `Platform: ${report.browser?.platform || 'Unknown'}`,
    '',
    '[Access and settings]',
    `Pro: ${yesNo(report.access?.isPro)}`,
    `Legacy access: ${yesNo(report.access?.isLegacyUser)}`,
    `Diagnostic event history: ${report.access?.eventHistory ? 'available' : 'Pro only'}`,
    `Debug mode: ${yesNo(report.settings?.debugMode)}`,
    `Security mode: ${report.settings?.mode || 'unknown'}`,
    `Disabled categories: ${(report.settings?.disabledCategories || []).join(', ') || 'none'}`,
    '',
    '[Rules and DNR]',
    `Stored rules: ${report.rules?.total ?? 0}`,
    `Blacklist rules: ${report.rules?.blacklist ?? 0}`,
    `Whitelist rules: ${report.rules?.whitelist ?? 0}`,
    `Scheduled rules: ${report.rules?.scheduled ?? 0}`,
    `User-disabled rules: ${report.rules?.disabledByUser ?? 0}`,
    `Browser DNR rules: ${report.dnr?.currentCount ?? 0}`,
    `Expected DNR rules: ${report.dnr?.expectedCount ?? 0}`,
    `DNR integrity: ${dnrStatus}`,
    `Last DNR change/error: ${formatTimestamp(report.dnr?.lastResult?.timestamp)}`,
    '',
    '[Daily Limits]',
    `Configured rules: ${report.dailyLimits?.configuredRules ?? 0}`,
    `Usage entries: ${report.dailyLimits?.usageEntries ?? 0}`,
    `Last sample: ${formatTimestamp(report.dailyLimits?.tracker?.lastSampleAt)}`,
    `Last sample reason: ${report.dailyLimits?.tracker?.lastReason || 'not recorded'}`,
    `Last resolution: ${report.dailyLimits?.tracker?.resolution || 'not recorded'}`,
    `Active rule ID: ${report.dailyLimits?.tracker?.activeRuleId ?? 'none'}`,
    `Focus source: ${report.dailyLimits?.tracker?.focusSource || 'not recorded'}`,
    `Last added seconds: ${report.dailyLimits?.tracker?.addedSeconds ?? 0}`,
    `Current usage seconds: ${report.dailyLimits?.tracker?.currentUsageSeconds ?? 0}`,
    `Resolution error: ${report.dailyLimits?.tracker?.errorName || 'none'}`,
    '',
    '[Permissions and focus]',
    `Host access: ${report.permissions?.hostAccess ? 'granted' : 'missing'}`,
    `Focus active: ${yesNo(focus.active)}`,
    `Focus mode: ${focus.mode || 'blacklist'}`,
    `Hardcore: ${yesNo(focus.hardcore)}`,
    `Remaining minutes: ${focus.remainingMinutes ?? 0}`,
    '',
    '[License]',
    `Last check: ${formatTimestamp(report.license?.lastCheck?.timestamp)}`,
    `Last check success: ${report.license?.lastCheck ? yesNo(report.license.lastCheck.success) : 'not recorded'}`,
    '',
    '[Technical analytics]',
    `Enabled: ${yesNo(report.telemetry?.enabled)}`,
    `Pending days: ${report.telemetry?.pendingDays ?? 0}`,
    `Pending counters: ${report.telemetry?.pendingCounterTotal ?? 0}`,
    `Pending error fingerprints: ${report.telemetry?.pendingErrorFingerprints ?? 0}`,
    `Last delivery success: ${formatTimestamp(report.telemetry?.delivery?.lastSuccessAt)}`,
    `Last delivery failure: ${formatTimestamp(report.telemetry?.delivery?.lastFailureAt)}`,
    `Last delivery failure reason: ${report.telemetry?.delivery?.lastFailureReason || 'not recorded'}`,
    `Last delivery status: ${report.telemetry?.delivery?.lastStatus ?? 'not recorded'}`,
    `Delivery failures: ${report.telemetry?.delivery?.failureCount ?? 0}`,
    `Next delivery attempt: ${formatTimestamp(report.telemetry?.delivery?.nextAttemptAt)}`,
    '',
    `[Recent diagnostic events: ${report.recentEvents?.length || 0}]`
  ];

  for (const event of report.recentEvents || []) {
    lines.push(
      `${formatTimestamp(event.timestamp)} | ${String(event.level || 'info').toUpperCase()} | ${event.source || 'extension'} | ${event.code || 'unknown'} | ${JSON.stringify(event.details || {})}`
    );
  }

  return lines.join('\n');
}
