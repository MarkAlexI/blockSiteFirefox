// Fixed source catalog shared with the telemetry receiver; no user-controlled paths.
const WORKER_ERROR_MODULES = Object.freeze({
  "backup/backupFormat.js": "backup_backup_format",
  "diagnostics/diagnosticReport.js": "diagnostics_diagnostic_report",
  "diagnostics/diagnosticStore.js": "diagnostics_diagnostic_store",
  "options/proGuidanceController.js": "options_pro_guidance_controller",
  "options/settings.js": "options_settings",
  "options/statisticsCharts.js": "options_statistics_charts",
  "options/userGuidance.js": "options_user_guidance",
  "pro/isUrlInWhitelist.js": "pro_is_url_in_whitelist",
  "pro/password.js": "pro_password",
  "pro/proManager.js": "pro_pro_manager",
  "pro/statisticsHistory.js": "pro_statistics_history",
  "pro/statisticsManager.js": "pro_statistics_manager",
  "rules/blockingMode.js": "rules_blocking_mode",
  "rules/categoryManager.js": "rules_category_manager",
  "rules/dailyLimitManager.js": "rules_daily_limit_manager",
  "rules/dailyLimitTracker.js": "rules_daily_limit_tracker",
  "rules/dnrRuleFactory.js": "rules_dnr_rule_factory",
  "rules/normalizeDomainRule.js": "rules_normalize_domain_rule",
  "rules/normalizePathRule.js": "rules_normalize_path_rule",
  "rules/normalizePathSegment.js": "rules_normalize_path_segment",
  "rules/ruleActivation.js": "rules_rule_activation",
  "rules/ruleAssignments.js": "rules_rule_assignments",
  "rules/ruleListsManager.js": "rules_rule_lists_manager",
  "rules/rulePacks.js": "rules_rule_packs",
  "rules/rulesClient.js": "rules_rules_client",
  "rules/rulesErrorClassification.js": "rules_rules_error_classification",
  "rules/rulesIntentRouter.js": "rules_rules_intent_router",
  "rules/rulesManager.js": "rules_rules_manager",
  "rules/rulesMigrationNotice.js": "rules_rules_migration_notice",
  "rules/rulesMigrationService.js": "rules_rules_migration_service",
  "rules/rulesMutationFeedback.js": "rules_rules_mutation_feedback",
  "rules/rulesMutationService.js": "rules_rules_mutation_service",
  "rules/urlRuleMatcher.js": "rules_url_rule_matcher",
  "schedules/focusSchedule.js": "schedules_focus_schedule",
  "schedules/focusScheduleController.js": "schedules_focus_schedule_controller",
  "schedules/scheduleNormalizer.js": "schedules_schedule_normalizer",
  "schedules/scheduleValidator.js": "schedules_schedule_validator",
  "scripts/closeTabs.js": "scripts_close_tabs",
  "scripts/dnrSynchronizer.js": "scripts_dnr_synchronizer",
  "scripts/isBlockedURL.js": "scripts_is_blocked_url",
  "scripts/isValidPathSegment.js": "scripts_is_valid_path_segment",
  "scripts/isValidURL.js": "scripts_is_valid_url",
  "scripts/service_worker.js": "scripts_service_worker",
  "scripts/spaNavigationEnforcer.js": "scripts_spa_navigation_enforcer",
  "scripts/t.js": "scripts_t",
  "telemetry/asyncHandlerBoundary.js": "telemetry_async_handler_boundary",
  "telemetry/errorLocation.js": "telemetry_error_location",
  "telemetry/installedEventBoundary.js": "telemetry_installed_event_boundary",
  "telemetry/telemetryClient.js": "telemetry_telemetry_client",
  "telemetry/telemetryConsent.js": "telemetry_telemetry_consent",
  "telemetry/telemetryContext.js": "telemetry_telemetry_context",
  "telemetry/telemetryLicenseError.js": "telemetry_telemetry_license_error",
  "telemetry/telemetryRuleError.js": "telemetry_telemetry_rule_error",
  "telemetry/telemetryRulePack.js": "telemetry_telemetry_rule_pack",
  "telemetry/telemetrySanitizer.js": "telemetry_telemetry_sanitizer",
  "telemetry/telemetryStore.js": "telemetry_telemetry_store",
  "telemetry/workerErrorReporter.js": "telemetry_worker_error_reporter",
  "utils/buildInfo.js": "utils_build_info",
  "utils/constants.js": "utils_constants",
  "utils/createInstallURL.js": "utils_create_install_url",
  "utils/focusSession.js": "utils_focus_session",
  "utils/focusSound.js": "utils_focus_sound",
  "utils/hostPermissionMonitor.js": "utils_host_permission_monitor",
  "utils/logger.js": "utils_logger",
  "utils/protectedDomains.js": "utils_protected_domains",
  "utils/redirectAuthorization.js": "utils_redirect_authorization",
  "utils/resolveContextTarget.js": "utils_resolve_context_target",
  "utils/shouldSkipSync.js": "utils_should_skip_sync",
  "utils/soundPlayer.js": "utils_sound_player",
  "utils/soundService.js": "utils_sound_service",
  "utils/storeTarget.js": "utils_store_target",
  "utils/updateUninstallURL.js": "utils_update_uninstall_url"
});
const MODULE_IDS = new Set(Object.values(WORKER_ERROR_MODULES));
const MAX_ERROR_SOURCE_LINE = 100_000;

function sanitizeErrorLocation(location) {
  try {
    if (!location || typeof location !== 'object' || Array.isArray(location)) return undefined;
    const keys = Object.keys(location);
    if (keys.length !== 2 || !keys.includes('module') || !keys.includes('line')) return undefined;
    if (!MODULE_IDS.has(location.module) || !Number.isInteger(location.line) ||
        location.line < 1 || location.line > MAX_ERROR_SOURCE_LINE) return undefined;
    return { module: location.module, line: location.line };
  } catch { return undefined; }
}

function errorLocationSuffix(location) {
  const safe = sanitizeErrorLocation(location);
  return safe ? `:at:${safe.module}:${safe.line}` : '';
}

export { WORKER_ERROR_MODULES, MAX_ERROR_SOURCE_LINE, sanitizeErrorLocation, errorLocationSuffix };
