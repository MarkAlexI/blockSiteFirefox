import { RulesManager } from '../rules/rulesManager.js';
import { SettingsManager } from '../options/settings.js';
import { StatisticsManager } from '../pro/statisticsManager.js';
import { ProManager } from '../pro/proManager.js';
import { closeTabsMatchingRules, closeNonWhitelistedTabs } from './closeTabs.js';
import { normalizeDomainRule } from '../rules/normalizeDomainRule.js';
import { normalizePathRule } from '../rules/normalizePathRule.js';
import Logger from '../utils/logger.js';
import { resolveContextTarget } from '../utils/resolveContextTarget.js';
import { VERIFY_API_URL, IS_FIREFOX, LICENSE_SYNC_TIMEOUT_MS, MAX_RULES_LIMIT } from '../utils/constants.js';
import { updateUninstallURL } from '../utils/updateUninstallURL.js';
import { createInstallURL } from '../utils/createInstallURL.js';
import { shouldSkipSync } from '../utils/shouldSkipSync.js';
import { isBlockedURL } from './isBlockedURL.js';
import { getFocusSessionState } from '../utils/focusSession.js';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';
import { createDnrSynchronizer } from './dnrSynchronizer.js';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { isRuleActiveNow } from '../rules/ruleActivation.js';
import { BLOCKING_MODE_DAILY_LIMIT } from '../rules/blockingMode.js';
import { getAssignmentUsageKey, getRuleAssignment, getRuleAssignments } from '../rules/ruleAssignments.js';
import { createRulesMigrationService } from '../rules/rulesMigrationService.js';
import { claimRulesMigrationNotice } from '../rules/rulesMigrationNotice.js';
import { GENERAL_RULE_LIST_ID, RuleListsManager } from '../rules/ruleListsManager.js';
import { DailyLimitManager } from '../rules/dailyLimitManager.js';
import { createDailyLimitTracker, DAILY_LIMIT_DEADLINE_ALARM } from '../rules/dailyLimitTracker.js';
import { createRulesMutationService, serializeRulesMutationError } from '../rules/rulesMutationService.js';
import { RULES_INTENT_TYPES, createRulesIntentHandler } from '../rules/rulesIntentRouter.js';
import { resolveRulePackEntries } from '../rules/rulePacks.js';
import { createDiagnosticStore } from '../diagnostics/diagnosticStore.js';
import { buildDiagnosticReport, detectBrowserSummary } from '../diagnostics/diagnosticReport.js';
import { createHostPermissionMonitor, affectsRequiredHostAccess } from '../utils/hostPermissionMonitor.js';
import { getTelemetryConsent, TELEMETRY_DATA_COLLECTION_PERMISSION } from '../telemetry/telemetryConsent.js';
import { createTelemetryStore } from '../telemetry/telemetryStore.js';
import { createTelemetryClient } from '../telemetry/telemetryClient.js';
import { buildTelemetryContext } from '../telemetry/telemetryContext.js';
import { getRulesTelemetryCode, shouldRecordRulesTelemetryError } from '../telemetry/telemetryRuleError.js';
import { isExpectedRulesRejection } from '../rules/rulesErrorClassification.js';
import { shouldRecordLicenseReliabilityError } from '../telemetry/telemetryLicenseError.js';

const logger = new Logger('Worker');
const rulesManager = new RulesManager();
const ruleListsManager = new RuleListsManager(browser.storage.local);
const dailyLimitManager = new DailyLimitManager(browser.storage.local);
let pendingDailyUsageRecovery = null;

async function getFocusAccess() {
  return ProManager.getAccess();
}


function getDailyLimitAssignmentKeys(rules = []) {
  return (rules || []).flatMap(rule =>
    getRuleAssignments(rule)
      .filter(assignment => assignment.blockingMode === BLOCKING_MODE_DAILY_LIMIT)
      .map(assignment => getAssignmentUsageKey(rule.id, assignment.listId))
      .filter(Boolean)
  );
}

async function recoverPendingDailyUsage(reason, force = false) {
  if (!force && pendingDailyUsageRecovery === false) return true;

  try {
    await dailyLimitManager.recoverPendingRemaps();
    pendingDailyUsageRecovery = false;
    return true;
  } catch (error) {
    try {
      const remaps = await dailyLimitManager.loadPendingRemaps();
      pendingDailyUsageRecovery = remaps.length > 0;
      if (!pendingDailyUsageRecovery) return true;
    } catch {
      pendingDailyUsageRecovery = true;
    }
    logger.warn(`Daily Limit usage recovery failed (${reason}):`, error);
    return false;
  }
}
const diagnosticStore = createDiagnosticStore({
  localStorage: browser.storage.local,
  getSettings: async () => {
    const [settings, access] = await Promise.all([
      SettingsManager.getSettings(),
      ProManager.getAccess()
    ]);
    return {
      ...settings,
      debugMode: settings.debugMode === true && (access.isPro || access.isLegacyUser)
    };
  }
});

const hostPermissionMonitor = createHostPermissionMonitor({
  permissionsApi: browser.permissions,
  tabsApi: browser.tabs,
  runtimeApi: browser.runtime,
  diagnosticStore,
  logger
});

const TELEMETRY_RETRY_ALARM = 'telemetry_retry';

async function getCurrentTelemetryContext() {
  const { credentials, isPro, isLegacyUser } = await ProManager.getAccess();
  return buildTelemetryContext({
    manifest: browser.runtime.getManifest(),
    navigatorRef: globalThis.navigator || {},
    locale: browser.i18n.getUILanguage?.() || 'en',
    isPro,
    isLegacyUser,
    installationDate: credentials.installationDate
  });
}

const telemetryStore = createTelemetryStore({
  localStorage: browser.storage.local,
  getConsent: () => getTelemetryConsent(browser.storage.local, browser.permissions),
  getContext: getCurrentTelemetryContext
});

const telemetryClient = createTelemetryClient({
  localStorage: browser.storage.local,
  permissionsApi: browser.permissions,
  store: telemetryStore,
  getContext: getCurrentTelemetryContext,
  scheduleRetry: async (when) => {
    await browser.alarms.clear(TELEMETRY_RETRY_ALARM);
    browser.alarms.create(TELEMETRY_RETRY_ALARM, { when });
  },
  cancelRetry: () => browser.alarms.clear(TELEMETRY_RETRY_ALARM)
});

const RULE_INTENT_COUNTERS = new Map([
  ['rules:add', 'rule_created'],
  ['rules:update', 'rule_updated'],
  ['rules:removeAssignment', 'rule_deleted'],
  ['rules:delete', 'rule_deleted'],
  ['rules:toggle', 'rule_toggled'],
  ['rules:replaceAll', 'rules_imported'],
  ['rules:clear', 'rules_cleared'],
  ['rules:toggleCategory', 'category_toggled']
]);

async function recordRuleIntentTelemetry(type, result) {
  if (type === 'rules:addMany') {
    const changedCount = Number(result?.addedCount) || 0;
    const newRuleCount = Number(result?.newRuleCount ?? result?.addedCount) || 0;
    const telemetryTasks = [];
    if (changedCount > 0) {
      telemetryTasks.push(telemetryStore.incrementCounter('rule_pack_imported'));
    }
    if (newRuleCount > 0) {
      telemetryTasks.push(telemetryStore.incrementCounter('rule_pack_rules_added', newRuleCount));
    }
    if (telemetryTasks.length > 0) await Promise.all(telemetryTasks);
    return;
  }

  const counter = RULE_INTENT_COUNTERS.get(type);
  if (counter) await telemetryStore.incrementCounter(counter);
}

async function settleRulesIntentPostCommitTasks(type, result) {
  const cleanupAndSample = (async () => {
    if (result.dailyUsageSyncPending) {
      pendingDailyUsageRecovery = true;
      if (!await recoverPendingDailyUsage('rules_intent', true)) return;
    }

    try {
      await dailyLimitManager.pruneAssignmentKeys(
        getDailyLimitAssignmentKeys(result.rules || [])
      );
    } catch (error) {
      logger.info('Rules post-commit Daily Limit cleanup failed:', error);
    }

    await dailyLimitTracker.sample('rules_intent');
  })();

  const outcomes = await Promise.allSettled([
    cleanupAndSample,
    recordRuleIntentTelemetry(type, result)
  ]);

  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      logger.info('Rules post-commit side effect failed:', outcome.reason);
    }
  }
}

let lastRecordedDnrFailureSignature = null;

function getDnrFailureSignature(result) {
  const failureCode = result.errorCode === 'dnr_rule_limit_reached' ||
    result.code === 'dnr_rule_limit_reached'
    ? 'rule_limit_reached'
    : 'sync_failed';
  const capacity = result.capacity ? {
    limitType: result.capacity.limitType || null,
    expectedCount: result.capacity.expectedCount ?? null,
    expectedUnsafeCount: result.capacity.expectedUnsafeCount ?? null,
    maxDynamicRules: result.capacity.maxDynamicRules ?? null,
    maxUnsafeDynamicRules: result.capacity.maxUnsafeDynamicRules ?? null
  } : null;
  return JSON.stringify([
    failureCode,
    result.errorName || 'Error',
    result.error || null,
    capacity
  ]);
}

async function recordDnrSyncResult(result) {
  const failureCode = result.code === 'dnr_rule_limit_reached'
    ? 'rule_limit_reached'
    : 'sync_failed';
  const failureSignature = !result.success
    ? getDnrFailureSignature(result)
    : null;

  if (failureSignature && failureSignature === lastRecordedDnrFailureSignature) {
    return;
  }
  if (failureSignature && lastRecordedDnrFailureSignature === null) {
    try {
      const previous = (await diagnosticStore.getState()).lastDnrSync;
      if (previous?.success === false &&
        getDnrFailureSignature(previous) === failureSignature) {
        lastRecordedDnrFailureSignature = failureSignature;
        return;
      }
    } catch (error) {
      logger.warn('Previous DNR synchronization failure could not be inspected:', error);
    }
  }
  const recoveredFromFailure = result.success && lastRecordedDnrFailureSignature !== null;
  if (result.success) lastRecordedDnrFailureSignature = null;

  const persistenceTasks = [];
  if (result.changed || !result.success || recoveredFromFailure) {
    persistenceTasks.push(diagnosticStore.updateState({
      lastDnrSync: {
        timestamp: Date.now(),
        success: result.success,
        changed: result.changed,
        removed: result.removed,
        added: result.added,
        error: result.error || null,
        errorCode: result.code || null,
        errorName: result.errorName || null,
        capacity: result.capacity || null
      }
    }));
  }

  if (!result.success) {
    persistenceTasks.push(
      diagnosticStore.recordEvent('error', 'dnr', 'sync_failed', {
        removed: result.removed,
        added: result.added,
        error: result.error || 'Unknown DNR synchronization error',
        errorCode: result.code || null,
        capacity: result.capacity || null
      }),
      telemetryStore.recordError({
        source: 'dnr',
        code: failureCode,
        operation: 'update_dynamic_rules',
        errorName: result.errorName || 'Error'
      })
    );
  }

  const outcomes = await Promise.allSettled(persistenceTasks);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      logger.warn('DNR synchronization reporting could not be persisted:', outcome.reason);
    }
  }
  if (failureSignature && outcomes.some(outcome => outcome.status === 'fulfilled')) {
    lastRecordedDnrFailureSignature = failureSignature;
  }
}
const createDnrRule = createDnrRuleFactory(
  path => browser.runtime.getURL(path)
);

const dnrSynchronizer = createDnrSynchronizer({
  getRules: () => rulesManager.getRules(),
  getRuleListState: () => ruleListsManager.getState(),
  getDailyUsage: () => dailyLimitManager.getUsageSeconds(),
  getFocusSessionState,
  getAccess: getFocusAccess,
  isRuleActiveNow,
  createDnrRule,
  closeTabsMatchingRules,
  declarativeNetRequest: browser.declarativeNetRequest,
  logger,
  onSyncResult: recordDnrSyncResult
});

const dailyLimitTracker = createDailyLimitTracker({
  tabsApi: browser.tabs,
  scriptingApi: browser.scripting,
  alarmsApi: browser.alarms,
  getRules: () => rulesManager.getRules(),
  getRuleListState: () => ruleListsManager.getState(),
  getFocusSessionState,
  dailyLimitManager,
  dnrSynchronizer,
  logger
});

const rulesMigrationService = createRulesMigrationService({
  rulesManager,
  ruleListsManager,
  localStorage: browser.storage.local,
  syncStorage: browser.storage.sync,
  logger
});

function notifyRulesChanged(rules, extra = {}) {
  try {
    const request = browser.runtime.sendMessage({
      type: 'rules:changed',
      rules,
      ...extra
    });

    if (request && typeof request.catch === 'function') {
      request.catch(() => {});
    }
  } catch (error) {
    logger.info('No active extension page received rules:changed:', error);
  }
}

const rulesMutationService = createRulesMutationService({
  rulesManager,
  ruleListsManager,
  dnrSynchronizer,
  dailyLimitManager,
  declarativeNetRequest: browser.declarativeNetRequest,
  getAccess: () => ProManager.getAccess(),
  getSettings: () => SettingsManager.getSettings(),
  saveSettings: (settings) => browser.storage.sync.set({ settings }),
  saveRulesAndLists: (rules, ruleLists, activeRuleListId) => browser.storage.local.set({ rules, ruleLists, ...(activeRuleListId ? { activeRuleListId } : {}) }),
  maxRulesLimit: MAX_RULES_LIMIT,
  notifyRulesChanged,
  resolveRulePackEntries,
  logger
});

const handleRulesIntent = createRulesIntentHandler(rulesMutationService);

/**
 * Checks a single tab URL against active Whitelist rules during 'whitelist' Focus Session.
 * Closes the tab if the URL is not whitelisted and is not a system/extension page.
 */
async function enforceFocusWhitelist(tabId, tabUrl) {
  if (isBlockedURL([{ url: tabUrl }])) {
    return;
  }

  const transitionGeneration = focusSessionTransitionGeneration;
  const shouldContinue = () => transitionGeneration === focusSessionTransitionGeneration;
  
  const { focusActive, focusMode } = await getFocusSessionState();
  if (!shouldContinue() || !focusActive || focusMode !== 'whitelist') {
    return;
  }
  
  const rules = await rulesManager.getRules();
  if (!shouldContinue()) return;
  const whitelistRules = rules.filter(r =>
    r.isWhitelist && getRuleAssignment(r, GENERAL_RULE_LIST_ID)?.disabledByUser !== true
  );
  
  if (!isUrlInWhitelist(tabUrl, whitelistRules)) {
    const currentSession = await getFocusSessionState();
    if (
      !shouldContinue() ||
      currentSession.focusActive !== true ||
      currentSession.focusMode !== 'whitelist'
    ) return;

    const currentRules = await rulesManager.getRules();
    if (!shouldContinue()) return;
    const currentWhitelistRules = currentRules.filter(r =>
      r.isWhitelist && getRuleAssignment(r, GENERAL_RULE_LIST_ID)?.disabledByUser !== true
    );
    if (isUrlInWhitelist(tabUrl, currentWhitelistRules)) return;

    logger.log(`Focus Whitelist: Closing non-whitelisted tab ${tabId} (${tabUrl})`);
    await browser.tabs.remove(tabId).catch(() => {});
  }
}

/**
 * Scans all currently open tabs and closes any tab that does not match active Whitelist rules.
 */
async function checkAllTabsAgainstWhitelist(shouldContinue = () => true) {
  if (!shouldContinue()) return;
  const rules = await rulesManager.getRules();
  if (!shouldContinue()) return;
  const whitelistRules = rules.filter(r =>
    r.isWhitelist && getRuleAssignment(r, GENERAL_RULE_LIST_ID)?.disabledByUser !== true
  );
  
  await closeNonWhitelistedTabs(whitelistRules, shouldContinue);
}

let stateTransitionTail = Promise.resolve();
let proStatusTransitionGeneration = 0;
let licenseVerificationGeneration = 0;
let activeLicenseActivationGeneration = null;
let focusSessionTransitionGeneration = 0;
const FOCUS_COMPLETION_ALARM = 'end_focus_session';
const INACTIVE_FOCUS_SESSION = Object.freeze({
  focusActive: false,
  focusEndTime: 0,
  isHardcore: false,
  focusMode: 'blacklist'
});

function enqueueStateTransition(task) {
  const result = stateTransitionTail.then(task, task);
  stateTransitionTail = result.catch(() => {});
  return result;
}

function enqueueProStatusTransition(task) {
  return enqueueStateTransition(task);
}

function enqueueFocusSessionTransition(task) {
  return enqueueStateTransition(task);
}

async function runFocusCompletionTask(name, operation) {
  try {
    return await operation();
  } catch (error) {
    logger.error(`Focus Session recovery: ${name} failed:`, error);
    return null;
  }
}

async function reportFocusRecoveryFailure(reason, error) {
  const outcomes = await Promise.allSettled([
    diagnosticStore.recordEvent('error', 'focus', 'recovery_failed', { reason, error }),
    telemetryStore.recordError({
      source: 'focus',
      code: 'recovery_failed',
      operation: 'recover_session',
      errorName: error?.name || 'Error'
    })
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      logger.info('Focus recovery failure reporting could not be persisted:', outcome.reason);
    }
  }
}

function getFocusCompletionAlarm() {
  let result;
  try {
    result = browser.alarms.get(FOCUS_COMPLETION_ALARM);
  } catch (_) {
    result = undefined;
  }

  if (result && typeof result.then === 'function') return result;
  if (result !== undefined) return Promise.resolve(result);

  return new Promise((resolve, reject) => {
    try {
      browser.alarms.get(FOCUS_COMPLETION_ALARM, alarm => {
        const runtimeError = browser.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || String(runtimeError)));
          return;
        }
        resolve(alarm ?? null);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function ensureFocusCompletionAlarm(endTime, shouldContinue) {
  const existing = await getFocusCompletionAlarm();
  if (!shouldContinue()) return false;

  const scheduledTime = Number(existing?.scheduledTime ?? existing?.when);
  if (Number.isFinite(scheduledTime) && Math.abs(scheduledTime - endTime) <= 1000) {
    return false;
  }

  await browser.alarms.create(FOCUS_COMPLETION_ALARM, { when: endTime });
  return true;
}

async function showFocusCompletionNotification() {
  if (!browser.notifications) return;
  const settings = await SettingsManager.getSettings();
  browser.notifications.create('focus_session_ended', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('images/icon-192.png'),
    title: browser.i18n.getMessage('focussessionheader'),
    message: browser.i18n.getMessage('focussessionended'),
    priority: 2,
    silent: !settings.focusSessionSound
  });
}

async function reconcileStoredFocusSession(reason, {
  transitionGeneration,
  expectedEndTime = null,
  allowEarlyCompletion = false,
  rearmFuture = true,
  invalidateGeneration = true
} = {}) {
  const shouldContinue = () => transitionGeneration === focusSessionTransitionGeneration;
  if (!shouldContinue()) return { status: 'superseded' };

  const result = await browser.storage.local.get(['focusSession']);
  if (!shouldContinue()) return { status: 'superseded' };

  const focusSession = result.focusSession;
  if (focusSession?.focusActive !== true) return { status: 'inactive' };

  const endTime = Number(focusSession.focusEndTime);
  const hasValidEndTime = Number.isFinite(endTime) && endTime > 0;
  const expected = Number(expectedEndTime);
  if (
    hasValidEndTime &&
    Number.isFinite(expected) &&
    expected > 0 &&
    Math.abs(expected - endTime) > 1000
  ) {
    logger.log('Focus Session: Ignoring a stale completion alarm.');
    return { status: 'stale_alarm' };
  }

  const now = Date.now();
  const completionDue = !hasValidEndTime ||
    (allowEarlyCompletion ? now + 1000 >= endTime : now >= endTime);
  if (!completionDue) {
    if (rearmFuture) {
      const alarmCreated = await ensureFocusCompletionAlarm(endTime, shouldContinue);
      if (!shouldContinue()) return { status: 'superseded' };
      return { status: 'active', alarmCreated };
    }
    return { status: 'active', alarmCreated: false };
  }

  await runFocusCompletionTask(
    'pre-completion Daily Limit sample',
    () => dailyLimitTracker.sample('focus_complete_before')
  );
  if (!shouldContinue()) return { status: 'superseded' };

  await browser.storage.local.set({ focusSession: { ...INACTIVE_FOCUS_SESSION } });
  if (invalidateGeneration && shouldContinue()) {
    focusSessionTransitionGeneration += 1;
  }

  await Promise.all([
    runFocusCompletionTask(
      'completion alarm cleanup',
      () => browser.alarms.clear(FOCUS_COMPLETION_ALARM)
    ),
    runFocusCompletionTask(
      'post-completion Daily Limit sample',
      () => dailyLimitTracker.sample('focus_complete_after')
    ),
    runFocusCompletionTask('DNR synchronization', () => dnrSynchronizer.requestSync())
  ]);

  if (!hasValidEndTime) {
    const outcomes = await Promise.allSettled([
      diagnosticStore.recordEvent('warn', 'focus', 'invalid_session_recovered', {
        reason
      }),
      telemetryStore.recordError({
        source: 'focus',
        code: 'invalid_session',
        operation: 'recover_session',
        errorName: 'Error'
      })
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        logger.info('Invalid Focus recovery reporting could not be persisted:', outcome.reason);
      }
    }
    return { status: 'invalid_state_recovered' };
  }

  const outcomes = await Promise.allSettled([
    StatisticsManager.recordFocusSession(),
    diagnosticStore.recordEvent('info', 'focus', 'session_completed', { reason }),
    telemetryStore.incrementCounter('focus_completed')
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      logger.info('Focus completion reporting could not be persisted:', outcome.reason);
    }
  }
  await runFocusCompletionTask('completion notification', showFocusCompletionNotification);
  return { status: 'completed' };
}

async function reconcileFocusSession(reason, options = {}) {
  const transitionGeneration = focusSessionTransitionGeneration;
  try {
    return await enqueueFocusSessionTransition(() => reconcileStoredFocusSession(reason, {
      ...options,
      transitionGeneration,
      invalidateGeneration: true
    }));
  } catch (error) {
    logger.error(`Focus Session recovery failed (${reason}):`, error);
    await reportFocusRecoveryFailure(reason, error);
    return { status: 'failed', error: error.message };
  }
}

function normalizeFocusSessionRequest(message) {
  const durationMinutes = message.duration ?? 25;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240) {
    return { error: 'invalid_focus_duration' };
  }

  const focusMode = message.focusMode ?? 'blacklist';
  if (focusMode !== 'blacklist' && focusMode !== 'whitelist') {
    return { error: 'invalid_focus_mode' };
  }

  const isHardcore = message.isHardcore ?? false;
  if (typeof isHardcore !== 'boolean') {
    return { error: 'invalid_focus_hardcore' };
  }

  return { durationMinutes, focusMode, isHardcore };
}

async function finishLicenseCheck(result) {
  const state = {
    timestamp: Date.now(),
    success: result.success,
    isPro: result.isPro,
    reason: result.reason || null,
    error: result.error || null
  };

  await diagnosticStore.updateState({ lastLicenseCheck: state });

  if (!result.success && result.reason !== 'no_key') {
    await diagnosticStore.recordEvent('warn', 'license', 'verification_failed', {
      reason: result.reason || 'temporary_failure',
      error: result.error || 'Unknown license verification error'
    });

    if (shouldRecordLicenseReliabilityError(result)) {
      await telemetryStore.recordError({
        source: 'license',
        code: 'verification_failed',
        operation: 'verification',
        errorName: 'Error'
      });
    }
  }

  return result;
}

async function recordSuccessfulLicenseActivation() {
  try {
    await finishLicenseCheck({
      success: true,
      isPro: true,
      reason: 'activated'
    });
  } catch (error) {
    logger.info('License activation diagnostics could not be persisted:', error);
  }
}

async function finishSupersededLicenseCheck() {
  const credentials = await ProManager.getCredentials();
  logger.log('License Sync: Ignoring a superseded verification response.');
  return finishLicenseCheck({
    success: true,
    isPro: credentials.isPro === true,
    reason: 'superseded'
  });
}

function createLicenseActivationError(message, code = 'activation_failed') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function activateLicenseKey(requestedKey) {
  if (typeof requestedKey !== 'string' || !requestedKey.trim()) {
    throw createLicenseActivationError('A valid license key is required', 'invalid_license_request');
  }

  const licenseKey = requestedKey.trim();
  const verificationGeneration = ++licenseVerificationGeneration;
  activeLicenseActivationGeneration = verificationGeneration;
  let timeoutId = null;

  try {
    await ProManager.getCredentials({ throwOnError: true });
    if (verificationGeneration !== licenseVerificationGeneration) {
      throw createLicenseActivationError('License activation was superseded', 'activation_superseded');
    }
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), LICENSE_SYNC_TIMEOUT_MS);
    const response = await fetch(VERIFY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: licenseKey,
        version: browser.runtime.getManifest().version
      }),
      signal: controller.signal
    });

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw createLicenseActivationError('License server returned invalid JSON');
    }

    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? 'invalid_license'
        : 'activation_failed';
      throw createLicenseActivationError(
        data?.error || `License verification failed (${response.status})`,
        code
      );
    }

    if (typeof data?.isPro !== 'boolean') {
      throw createLicenseActivationError('License server returned an invalid response');
    }

    if (data.isPro !== true) {
      throw createLicenseActivationError(data.error || 'Invalid license key', 'invalid_license');
    }

    if (verificationGeneration !== licenseVerificationGeneration) {
      throw createLicenseActivationError('License activation was superseded', 'activation_superseded');
    }

    const credentials = await handleProStatusUpdate(true, {
      licenseKey,
      subscriptionEmail: data.email,
      expiryDate: data.expiryDate
    });

    if (credentials?.isPro !== true || credentials.licenseKey !== licenseKey) {
      throw createLicenseActivationError('License activation was superseded', 'activation_superseded');
    }

    await recordSuccessfulLicenseActivation();
    return { isPro: true };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createLicenseActivationError('License verification timed out');
    }
    throw error;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (activeLicenseActivationGeneration === verificationGeneration) {
      activeLicenseActivationGeneration = null;
    }
  }
}

async function syncLicenseKeyStatus() {
  if (activeLicenseActivationGeneration !== null) {
    const credentials = await ProManager.getCredentials({ throwOnError: true });
    if (activeLicenseActivationGeneration !== null) {
      logger.log('License Sync: Manual activation is in progress, skipping sync.');
      return {
        success: true,
        isPro: credentials.isPro === true,
        reason: 'activation_in_progress'
      };
    }
  }

  const verificationGeneration = ++licenseVerificationGeneration;
  const credentials = await ProManager.getCredentials();
  const currentKey = credentials.licenseKey;
  
  if (!currentKey) {
    logger.log('License Sync: No key stored, skipping sync.');
    if (credentials.isPro) {
      const updated = await handleProStatusUpdate(
        false,
        { licenseKey: null, expiryDate: null, subscriptionEmail: null },
        { expectedLicenseKey: null, verificationGeneration }
      );
      if (!updated) return finishSupersededLicenseCheck();
    }
    return finishLicenseCheck({ success: false, isPro: false, reason: 'no_key' });
  }
  
  logger.log('License Sync: Checking stored key...');
  const version = browser.runtime.getManifest().version;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LICENSE_SYNC_TIMEOUT_MS);
  
  try {
    const response = await fetch(VERIFY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: currentKey,
        version
      }),
      signal: controller.signal
    });
    
    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error('License server returned invalid JSON', { cause: error });
    }
    
    if (!response.ok) {
      const errorMessage = data.error || `License verification failed (${response.status})`;
      const isDefinitiveRejection = response.status === 401 || response.status === 403;
      
      if (!isDefinitiveRejection) {
        throw new Error(errorMessage);
      }
      
      const updated = await handleProStatusUpdate(false, {
        licenseKey: null,
        expiryDate: null,
        subscriptionEmail: null
      }, { expectedLicenseKey: currentKey, verificationGeneration });
      if (!updated) return finishSupersededLicenseCheck();
      logger.warn(`License Sync: Server rejected the stored key (${response.status}).`);
      return finishLicenseCheck({ success: true, isPro: false, reason: 'rejected', error: errorMessage });
    }
    
    if (typeof data.isPro !== 'boolean') {
      throw new Error('License server returned an invalid response');
    }
    
    const updated = await handleProStatusUpdate(data.isPro, {
      licenseKey: currentKey,
      subscriptionEmail: data.email,
      expiryDate: data.expiryDate
    }, { expectedLicenseKey: currentKey, verificationGeneration });
    if (!updated) return finishSupersededLicenseCheck();
    
    logger.log('License Sync: Status updated from server. isPro:', data.isPro);
    return finishLicenseCheck({ success: true, isPro: data.isPro, reason: 'verified' });
    
  } catch (error) {
    const latestCredentials = await ProManager.getCredentials();
    if (
      verificationGeneration !== licenseVerificationGeneration ||
      latestCredentials.licenseKey !== currentKey
    ) {
      return finishSupersededLicenseCheck();
    }
    const errorMessage = error.name === 'AbortError' ?
      'License verification timed out' :
      error.message;
    logger.error('License Sync: Error:', errorMessage);
    return finishLicenseCheck({ success: false, isPro: credentials.isPro, reason: 'temporary_failure', error: errorMessage });
  } finally {
    clearTimeout(timeoutId);
  }
}

function updateContextMenu(hasPaidAccess) {
  if (!browser.contextMenus) return Promise.resolve();

  return new Promise(resolve => {
    browser.contextMenus.remove('blockDistraction', () => {
      void browser.runtime.lastError;

      if (hasPaidAccess) {
        const menuTitle = browser.i18n.getMessage('blockthat');

        browser.contextMenus.create({
          id: 'blockDistraction',
          title: menuTitle,
          contexts: IS_FIREFOX ? ['link'] : ['page', 'link']
        }, () => {
          void browser.runtime.lastError;
          logger.log('BlockDistraction context menu created');
          resolve();
        });
      } else {
        logger.log('BlockDistraction context menu removed (non-pro mode)');
        resolve();
      }
    });
  });
}

if (browser.contextMenus) {
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'blockDistraction') return;
    
    if (!await ProManager.hasPaidAccess()) {
      logger.warn('Attempted to block while not in pro mode');
      return;
    }
    
    const target = resolveContextTarget(info, tab);
    if (!target) {
      logger.info('No safe context target resolved');
      return;
    }
    
    if (isBlockedURL([target])) {
      logger.warn('Unsupported URL scheme:', target.url);
      return;
    }
    
    let ruleValue = null;
    
    if (target.type === 'link') {
      ruleValue = normalizePathRule(target.url);
    } else if (target.type === 'page') {
      ruleValue = normalizeDomainRule(target.url);
    }
    
    if (!ruleValue) {
      logger.info('Failed to normalize context target:', target);
      return;
    }
    
    try {
      await rulesMutationService.addRule({
        blockURL: decodeURIComponent(ruleValue),
        redirectURL: '',
        schedule: null,
        category: 'social',
        isWhitelist: false
      });
      
      logger.log(
        `Blocked ${target.type} via Context Menu:`,
        ruleValue
      );
      await telemetryStore.incrementCounter('rule_created');
      
    } catch (error) {
      logger.info('Error processing context menu block:', error);
    }
  });
}

async function showUpdates(details) {
  const version = browser.runtime.getManifest().version;
  if (!/\.0$/.test(version)) return true;
  
  try {
    const settings = await SettingsManager.getSettings();
    
    if (details.reason === 'update' && settings.showNotifications === true) {
      browser.tabs.create({
        url: browser.runtime.getURL(`update/update.html?version=${version}`)
      });
    }
  } catch (error) {
    logger.error('Error showing updates:', error);
    if (details.reason === 'update') {
      browser.tabs.create({
        url: browser.runtime.getURL(`update/update.html?version=${version}`)
      });
    }
  }
}

async function trackBlockedPage(url) {
  try {
    const extensionUrl = browser.runtime.getURL('');
    
    if (url.startsWith(extensionUrl) && url.includes('blocked.html')) {
      const urlObj = new URL(url);
      const blockedUrl = urlObj.searchParams.get('url');
      
      if (blockedUrl) {
        logger.log(`Recording block: ${blockedUrl}`);
        await StatisticsManager.recordBlock(blockedUrl);
      }
    }
  } catch (error) {
    logger.error('Error tracking blocked page:', error);
  }
}

async function restoreFreeRuleListAccess(shouldContinue = () => true) {
  const access = await ProManager.getAccess();
  if (!shouldContinue() || access.isPro || access.isLegacyUser) return false;

  return rulesMutationService.runExclusive(async () => {
    if (!shouldContinue()) return false;
    const state = await ruleListsManager.getState();
    if (!shouldContinue() || state.activeRuleListId === GENERAL_RULE_LIST_ID) return false;

    await dailyLimitTracker.pause('pro_access_lost');
    const currentAccess = await ProManager.getAccess();
    if (!shouldContinue() || currentAccess.isPro || currentAccess.isLegacyUser) return false;
    await ruleListsManager.setActiveListId(GENERAL_RULE_LIST_ID);

    const rules = await rulesManager.getRules();
    const syncResult = await dnrSynchronizer.requestSync();
    notifyRulesChanged(rules, {
      ruleLists: state.lists,
      activeRuleListId: GENERAL_RULE_LIST_ID,
      syncPending: syncResult?.success === false
    });

    logger.log('Free access restored to the General Rule List');
    return true;
  });
}

async function restoreFreeFocusAccess(
  shouldContinue = () => true,
  { ruleListRestored = false, alreadySerialized = false } = {}
) {
  const restore = async () => {
    const access = await ProManager.getAccess();
    if (!shouldContinue() || access.isPro || access.isLegacyUser) return false;

    const focusSession = await getFocusSessionState();
    if (!focusSession.focusActive || !shouldContinue()) return false;

    if (focusSession.focusMode === 'blacklist' && focusSession.isHardcore !== true) {
      if (!ruleListRestored && shouldContinue()) await dnrSynchronizer.requestSync();
      return false;
    }

    await browser.storage.local.set({
      focusSession: { ...focusSession, isHardcore: false, focusMode: 'blacklist' }
    });
    if (!shouldContinue()) return false;

    await dnrSynchronizer.requestSync();
    logger.log('Free access restored to the standard Focus Session');
    return true;
  };

  return alreadySerialized ? restore() : enqueueFocusSessionTransition(restore);
}

function handleProStatusUpdate(isPro, subscriptionData = {}, expectedVerification = null) {
  const transitionGeneration = expectedVerification
    ? proStatusTransitionGeneration
    : ++proStatusTransitionGeneration;

  if (!expectedVerification) licenseVerificationGeneration += 1;

  return enqueueProStatusTransition(async () => {
    try {
      if (expectedVerification) {
        const credentials = await ProManager.getCredentials();
        if (
          expectedVerification.verificationGeneration !== licenseVerificationGeneration ||
          credentials.licenseKey !== expectedVerification.expectedLicenseKey ||
          transitionGeneration !== proStatusTransitionGeneration
        ) {
          return null;
        }
      } else if (transitionGeneration !== proStatusTransitionGeneration) {
        return ProManager.getCredentials();
      }

      logger.log(`Service worker received Pro status update: ${isPro}`);
      const updatedCredentials = await ProManager.setProStatusFromWorker(isPro, subscriptionData);
      const shouldContinue = () => transitionGeneration === proStatusTransitionGeneration;
      if (!shouldContinue()) return updatedCredentials;

      const ruleListRestored = await restoreFreeRuleListAccess(shouldContinue);
      if (!shouldContinue()) return updatedCredentials;

      await restoreFreeFocusAccess(shouldContinue, {
        ruleListRestored,
        alreadySerialized: true
      });
      if (!shouldContinue()) return updatedCredentials;

      logger.log('Pro status updated successfully');
      await updateContextMenu(
        updatedCredentials.isPro === true || ProManager.resolveLegacyAccess(updatedCredentials)
      );
      return updatedCredentials;
    } catch (error) {
      logger.error('Error handling Pro status update:', error);
      throw error;
    }
  });
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    await enforceFocusWhitelist(tabId, changeInfo.url);
    if (tab.active) await dailyLimitTracker.sample('tab_url_changed', new Date(), tab);
  }
  
  if (changeInfo.status === 'complete' && tab.url) {
    await trackBlockedPage(tab.url);
    if (tab.active) await dailyLimitTracker.sample('tab_load_complete', new Date(), tab);
  }
});

browser.tabs.onActivated.addListener((activeInfo) => {
  void browser.tabs.get(activeInfo.tabId)
    .then(tab => dailyLimitTracker.sample('tab_activated', new Date(), tab))
    .catch(error => logger.info('Daily limit tab activation sample failed:', error));
});

browser.windows?.onFocusChanged?.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    void dailyLimitTracker.pause('window_focus_lost');
    return;
  }
  void dailyLimitTracker.sample('window_focus_gained');
});

browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.id && tab.url) {
    await enforceFocusWhitelist(tab.id, tab.url);
    if (tab.active) await dailyLimitTracker.sample('tab_created', new Date(), tab);
  }
  
  if (tab.url && tab.url !== 'about:blank' && tab.url !== 'chrome://newtab/') {
    await trackBlockedPage(tab.url);
  }
});

browser.runtime.onStartup.addListener(async () => {
  try {
    await telemetryClient.restoreRetry();
  } catch (error) {
    logger.info('Could not restore the telemetry retry on startup:', error);
  }
  
  ensureAlarmsCreated();
  
  await initializeExtension({ reason: 'startup' });
  await checkAndRequestPermissions({ reason: 'startup' }, { notifyIfMissing: true });
  
  await dailyLimitTracker.sample('startup');
  logger.log("Extension startup - syncing DNR rules");
  await dnrSynchronizer.requestSync();
  
  try {
    if (!await shouldSkipSync()) {
      const result = await syncLicenseKeyStatus();
      const access = await ProManager.getAccess();
      logger.log('Startup: Pro status is', result.isPro, '- updating context menu...');
      await updateContextMenu(access.isPro || access.isLegacyUser);
      await browser.storage.local.set({ lastCheck: Date.now() });
    }
  } catch (error) {
    logger.error('Error syncing:', error);
  }
  
  await dnrSynchronizer.validateIntegrity();
});

async function initializeExtension(details) {
  logger.log("Initializing extension state (rules, settings, legacy status)...");
  const dailyUsageRecovered = await recoverPendingDailyUsage('startup', true);
  const migrationResult = await rulesMutationService.runExclusive(
    () => rulesMigrationService.migrateAll({
      skipDailyUsageMigration: !dailyUsageRecovered
    })
  );

  if (dailyUsageRecovered) {
    await dailyLimitManager.pruneAssignmentKeys(
      getDailyLimitAssignmentKeys(migrationResult.rules || [])
    );
  }

  if (migrationResult.userVisibleMigration) {
    await dnrSynchronizer.requestSync();

    let showMigrationNotice = false;
    try {
      showMigrationNotice = await claimRulesMigrationNotice({
        details,
        migrationResult,
        storageArea: chrome.storage.local,
        extensionVersion: chrome.runtime.getManifest().version
      });
    } catch (error) {
      // The notice is informational. If its one-time marker cannot be persisted,
      // skip the alert instead of risking repeated compatibility warnings.
      logger.info('Could not claim Rules migration notice:', error);
    }

    notifyRulesChanged(migrationResult.rules, {
      migrated: showMigrationNotice,
      ruleLists: migrationResult.ruleLists,
      activeRuleListId: migrationResult.activeRuleListId
    });
  }
  await SettingsManager.getSettings();
  await StatisticsManager.getStatistics();
  await reconcileFocusSession(details.reason || 'initialize');
  await showUpdates(details);
  
  try {
    if (details.reason === 'install') {
      const initialized = await ProManager.initializeInstallationMetadata({
        fallbackInstallationDate: new Date().toISOString()
      });
      logger.log(`New install: isLegacyUser set to ${initialized.credentials.isLegacyUser}`);
    } else if (details.reason === 'update') {
      const migration = await ProManager.initializeInstallationMetadata({
        fallbackInstallationDate: new Date(0).toISOString()
      });
      if (migration.changed) {
        logger.log('Migrated existing installation metadata');
      }
    } else {
      await ProManager.getCredentials({ throwOnError: true });
    }
    
    const ruleListRestored = await restoreFreeRuleListAccess();
    await restoreFreeFocusAccess(() => true, { ruleListRestored });
    const access = await ProManager.getAccess();
    await updateContextMenu(access.isPro || access.isLegacyUser);
  } catch (error) {
    logger.info('Error handling install/update for legacy:', error);
  }
}

async function checkAndRequestPermissions(details, options = {}) {
  const reason = details?.reason || 'unknown';
  const result = await hostPermissionMonitor.check({
    reason,
    notifyIfMissing: options.notifyIfMissing === true,
    assumeMissing: options.assumeMissing === true
  });

  if (result.transitionedToMissing) {
    await telemetryStore.recordError({
      source: 'permissions',
      code: 'host_access_missing',
      operation: reason,
      errorName: 'PermissionError'
    });
  } else if (result.error) {
    await telemetryStore.recordError({
      source: 'permissions',
      code: 'check_failed',
      operation: reason,
      errorName: result.error?.name || 'Error'
    });
  }

  return result.granted;
}

function affectsTelemetryConsent(permissions) {
  return Array.isArray(permissions?.data_collection) &&
    permissions.data_collection.includes(TELEMETRY_DATA_COLLECTION_PERMISSION);
}

if (browser.permissions?.onRemoved) {
  browser.permissions.onRemoved.addListener(async permissions => {
    if (affectsRequiredHostAccess(permissions.origins)) {
      await checkAndRequestPermissions(
        { reason: 'permission_removed' },
        { notifyIfMissing: true, assumeMissing: true }
      );
    }

    if (affectsTelemetryConsent(permissions)) {
      await telemetryClient.setConsent(false);
    }
  });
}

if (browser.permissions?.onAdded) {
  browser.permissions.onAdded.addListener(async permissions => {
    if (affectsRequiredHostAccess(permissions.origins)) {
      await checkAndRequestPermissions({ reason: 'permission_added' });
    }

    if (affectsTelemetryConsent(permissions)) {
      await telemetryClient.setConsent(true);
    }
  });
}

async function getDiagnosticsAccess() {
  const { isPro, isLegacyUser } = await ProManager.getAccess();
  return {
    isPro,
    isLegacyUser,
    eventHistory: isPro || isLegacyUser
  };
}

async function createDiagnosticReport() {
  const access = await getDiagnosticsAccess();
  const [settings, rules, ruleListState, credentials, focusSession, dailyUsage] = await Promise.all([
    SettingsManager.getSettings(),
    rulesManager.getRules(),
    ruleListsManager.getState(),
    ProManager.getCredentials(),
    getFocusSessionState(),
    dailyLimitManager.getUsageSeconds()
  ]);
  const ruleLists = ruleListState.lists;
  const activeProfile = ruleLists.find(list => list.id === ruleListState.activeRuleListId);

  let dnrState;
  try {
    dnrState = await dnrSynchronizer.inspectState();
  } catch (error) {
    dnrState = {
      activeRuleCount: 0,
      expectedCount: 0,
      currentCount: 0,
      inSync: null,
      removeCount: 0,
      addCount: 0,
      error: error?.message || String(error)
    };
    await diagnosticStore.recordEvent('error', 'dnr', 'inspection_failed', {
      error
    });
  }

  const [snapshot, telemetryConsent, telemetryBatches, telemetryDelivery] = await Promise.all([
    diagnosticStore.getSnapshot(),
    telemetryClient.getConsent(),
    telemetryStore.getPendingBatches(),
    telemetryStore.getDeliveryState()
  ]);

  const telemetrySummary = {
    enabled: telemetryConsent.enabled === true,
    pendingDays: telemetryBatches.length,
    pendingCounterTotal: telemetryBatches.reduce((sum, batch) =>
      sum + Object.values(batch.counters || {}).reduce((inner, value) => inner + (Number(value) || 0), 0), 0),
    pendingErrorFingerprints: telemetryBatches.reduce((sum, batch) =>
      sum + (Array.isArray(batch.errors) ? batch.errors.length : 0), 0),
    delivery: {
      lastSuccessAt: telemetryDelivery.lastSuccessAt || null,
      lastFailureAt: telemetryDelivery.lastFailureAt || null,
      lastFailureReason: telemetryDelivery.lastFailureReason || null,
      lastStatus: telemetryDelivery.lastStatus ?? null,
      failureCount: Number(telemetryDelivery.failureCount) || 0,
      nextAttemptAt: telemetryDelivery.nextAttemptAt || null
    }
  };

  let hostAccess = true;
  if (typeof browser.permissions?.contains === 'function') {
    try {
      hostAccess = await browser.permissions.contains({ origins: ['*://*/*'] });
    } catch {
      hostAccess = false;
    }
  }

  const manifest = browser.runtime.getManifest();
  const nav = globalThis.navigator || {};
  const remainingMs = focusSession.focusActive ?
    Math.max(0, focusSession.focusEndTime - Date.now()) : 0;

  return buildDiagnosticReport({
    generatedAt: new Date().toISOString(),
    extension: {
      version: manifest.version,
      manifestVersion: manifest.manifest_version || 3
    },
    browser: detectBrowserSummary({
      userAgent: nav.userAgent,
      userAgentData: nav.userAgentData,
      platform: nav.platform
    }),
    capabilities: {
      declarativeNetRequest: Boolean(browser.declarativeNetRequest),
      contextMenus: Boolean(browser.contextMenus),
      notifications: Boolean(browser.notifications),
      permissionsApi: Boolean(browser.permissions),
      alarms: Boolean(browser.alarms),
      scripting: Boolean(browser.scripting)
    },
    access,
    settings: {
      debugMode: settings.debugMode === true && access.eventHistory,
      mode: settings.mode || 'normal',
      disabledCategories: activeProfile?.disabledCategories || [],
      activeRuleListId: ruleListState.activeRuleListId,
      activeRuleListName: activeProfile?.name || 'General'
    },
    rules: {
      total: rules.length,
      blacklist: rules.filter(rule => !rule.isWhitelist).length,
      whitelist: rules.filter(rule => rule.isWhitelist).length,
      scheduled: rules.filter(rule =>
        getRuleAssignments(rule).some(assignment => assignment.blockingMode === 'schedule')
      ).length,
      disabledByUser: rules.filter(rule =>
        getRuleAssignment(
          rule,
          rule.isWhitelist ? GENERAL_RULE_LIST_ID : ruleListState.activeRuleListId
        )?.disabledByUser === true
      ).length,
      lists: ruleLists.length,
      activeList: ruleListState.activeRuleListId
    },
    dnr: {
      ...dnrState,
      lastResult: snapshot.state.lastDnrSync || null
    },
    permissions: {
      hostAccess,
      lastCheck: snapshot.state.lastPermissionCheck || null
    },
    focusSession: {
      active: focusSession.focusActive === true,
      mode: focusSession.focusMode || 'blacklist',
      hardcore: focusSession.isHardcore === true,
      remainingMinutes: Math.ceil(remainingMs / 60000)
    },
    dailyLimits: {
      configuredRules: rules.filter(rule =>
        !rule.isWhitelist && getRuleAssignments(rule).some(assignment => assignment.blockingMode === BLOCKING_MODE_DAILY_LIMIT)
      ).length,
      usageEntries: Object.keys(dailyUsage || {}).length,
      tracker: dailyLimitTracker.getDebugState()
    },
    license: {
      isPro: credentials.isPro === true,
      expiryDate: credentials.expiryDate || null,
      lastCheck: snapshot.state.lastLicenseCheck || null
    },
    telemetry: telemetrySummary,
    recentEvents: access.eventHistory ? snapshot.events : []
  });
}

browser.runtime.onInstalled.addListener(async (details) => {
  logger.log(`Extension event: ${details.reason}`);
  
  browser.runtime.setUninstallURL("https://blockdistraction.com/uninstall.html");
  
  ensureAlarmsCreated();
  await telemetryClient.restoreRetry();
  
  if (details.reason === 'install') {
    logger.log("This is a fresh install. Checking permissions...");
    await initializeExtension(details);
    await checkAndRequestPermissions(details, { notifyIfMissing: true });
    
    const installUrl = createInstallURL();
    browser.tabs.create({
      url: installUrl,
      active: true
    });
  } else if (details.reason === 'update') {
    logger.log("This is an update. Checking permissions...");
    await initializeExtension(details);
    await checkAndRequestPermissions(details, { notifyIfMissing: true });
  } else if (details.reason === 'chrome_update' || details.reason === 'browser_update') {
    logger.log("Browser updated.");
    await initializeExtension(details);
    await dnrSynchronizer.validateIntegrity();
    await checkAndRequestPermissions(details, { notifyIfMissing: true });
  } else if (details.reason === 'shared_module_update') {
    logger.log("Shared module updated.");
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (RULES_INTENT_TYPES.has(message.type)) {
    (async () => {
      try {
        const recovered = await recoverPendingDailyUsage('rules_intent');
        const committed = await handleRulesIntent(message);
        const result = recovered ? committed : {
          ...committed,
          dailyUsageSyncPending: true
        };
        await settleRulesIntentPostCommitTasks(message.type, result);
        sendResponse({ success: true, ...result });
      } catch (error) {
        const expectedRejection = isExpectedRulesRejection(error, message.type);
        if (expectedRejection) {
          logger.info(`Rules intent rejected (${message.type}):`, error?.code || 'unknown');
        } else {
          logger.error(`Rules intent failed (${message.type}):`, error);
        }
        const telemetryTasks = [
          diagnosticStore.recordEvent(
            expectedRejection ? 'info' : 'error',
            'rules',
            expectedRejection ? 'intent_rejected' : 'intent_failed',
            {
              intent: message.type,
              errorCode: error?.code || 'unknown',
              validationErrors: error?.validationErrors || []
            }
          )
        ];

        if (shouldRecordRulesTelemetryError(error, message.type)) {
          telemetryTasks.push(telemetryStore.recordError({
            source: 'rules',
            code: getRulesTelemetryCode(error),
            operation: message.type.replace('rules:', ''),
            errorName: error?.name || 'Error'
          }));
        }

        for (const outcome of await Promise.allSettled(telemetryTasks)) {
          if (outcome.status === 'rejected') {
            logger.info('Rules failure reporting could not be persisted:', outcome.reason);
          }
        }
        sendResponse({
          success: false,
          error: serializeRulesMutationError(error)
        });
      }
    })();
    return true;
  }
  
  if (message.type === 'diagnostics:getReport') {
    (async () => {
      try {
        const report = await createDiagnosticReport();
        await telemetryStore.incrementCounter('diagnostic_report_generated');
        sendResponse({ success: true, report });
      } catch (error) {
        sendResponse({
          success: false,
          error: {
            code: error?.code || 'diagnostics_failed',
            message: error?.message || String(error)
          }
        });
      }
    })();
    return true;
  }

  if (message.type === 'diagnostics:clearHistory') {
    (async () => {
      try {
        await diagnosticStore.clearEvents();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: {
            code: error?.code || 'diagnostics_failed',
            message: error?.message || String(error)
          }
        });
      }
    })();
    return true;
  }

  if (message.type === 'telemetry:getConsent') {
    (async () => {
      try {
        const consent = await telemetryClient.getConsent();
        sendResponse({ success: true, consent });
      } catch (error) {
        sendResponse({ success: false, error: { code: 'telemetry_consent_failed' } });
      }
    })();
    return true;
  }

  if (message.type === 'telemetry:setConsent') {
    (async () => {
      try {
        const consent = await telemetryClient.setConsent(message.enabled === true);
        sendResponse({ success: true, consent });
      } catch (error) {
        logger.error('Failed to update telemetry consent:', error);
        sendResponse({ success: false, error: { code: 'telemetry_consent_failed' } });
      }
    })();
    return true;
  }

  if (message.type === 'telemetry:incrementCounter') {
    (async () => {
      try {
        const recorded = await telemetryStore.incrementCounter(message.name);
        sendResponse({ success: true, recorded });
      } catch {
        sendResponse({
          success: false,
          recorded: false,
          error: { code: 'telemetry_counter_failed' }
        });
      }
    })();
    return true;
  }

  if (message.type === 'telemetry:recordError') {
    (async () => {
      await telemetryStore.recordError(message.payload || {});
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'telemetry:flush') {
    (async () => {
      const result = await telemetryClient.flush({ force: message.force === true });
      sendResponse({ success: true, result });
    })();
    return true;
  }

  if (message.type === 'close_current_tab') {
    if (sender.tab && sender.tab.id) {
      browser.tabs.remove(sender.tab.id);
    }
    return;
  }
  
  if (message.type === 'CLOSE_MATCHING_TABS') {
    closeTabsMatchingRules([message.url])
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        logger.error("Close tabs error:", err);
        sendResponse({ success: false });
      });
    return true;
  }
  
  if (message.type === 'record_block') {
    StatisticsManager.recordBlock(message.url);
    return;
  }
  
  if (message.type === 'record_redirect') {
    StatisticsManager.recordRedirect(message.from, message.to);
    return;
  }
  
  if (message.type === 'activate_pro_license') {
    (async () => {
      try {
        const result = await activateLicenseKey(message.licenseKey);
        sendResponse({ success: true, isPro: result.isPro });
      } catch (error) {
        sendResponse({
          success: false,
          error: error.message,
          code: error.code || 'activation_failed'
        });
      }
    })();
    return true;
  }

  if (message.type === 'logout_pro') {
    (async () => {
      try {
        await handleProStatusUpdate(false, {
          licenseKey: null,
          expiryDate: null,
          subscriptionEmail: null
        });
        sendResponse({ success: true, isPro: false });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'update_pro_status') {
    sendResponse({
      success: false,
      error: 'Direct Pro status changes are not allowed',
      code: 'unauthorized_pro_transition'
    });
    return true;
  }
  
  if (message.type === 'check_pro_status') {
    (async () => {
      try {
        const isPro = await ProManager.isPro();
        sendResponse({ isPro });
      } catch (error) {
        sendResponse({ isPro: false, error: error.message });
      }
    })();
    return true;
  }
  
  if (message.type === 'get_pro_credentials') {
    sendResponse({
      success: false,
      error: 'License credentials are not available through runtime messages',
      code: 'credentials_unavailable'
    });
    return true;
  }

  if (message.type === 'reload_rules') {
    (async () => {
      await dnrSynchronizer.requestSync();
      logger.log('Legacy rules reload completed.');
    })();
    return;
  }
  
  if (message.type === 'pro_status_changed') {
    void enqueueProStatusTransition(async () => {
      await updateContextMenu(await ProManager.hasPaidAccess());
    });
    return;
  }
  
  if (message.type === 'force_sync') {
    (async () => {
      try {
        const result = await syncLicenseKeyStatus();
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  
  if (message.type === 'start_focus_session') {
    const request = normalizeFocusSessionRequest(message);
    if (request.error) {
      sendResponse({ success: false, error: request.error, code: request.error });
      return true;
    }

    const transitionGeneration = ++focusSessionTransitionGeneration;
    (async () => {
      try {
        const completed = await enqueueFocusSessionTransition(async () => {
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          await reconcileStoredFocusSession('focus_start', {
            transitionGeneration,
            rearmFuture: false,
            invalidateGeneration: false
          });
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          const { durationMinutes, isHardcore, focusMode } = request;
          const access = await getFocusAccess();
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;
          if (
            !access.isPro &&
            !access.isLegacyUser &&
            (durationMinutes !== 25 || isHardcore || focusMode !== 'blacklist')
          ) {
            return { success: false, error: 'pro_required', code: 'pro_required' };
          }

          const endTime = Date.now() + durationMinutes * 60 * 1000;
          const nextFocusSession = {
            focusActive: true,
            focusEndTime: endTime,
            isHardcore,
            focusMode
          };
          const focusCapacity = await dnrSynchronizer.validateRuleCapacity(
            null,
            null,
            nextFocusSession,
            access
          );
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;
          if (focusCapacity.withinCapacity === false) {
            const unsafe = focusCapacity.limitType === 'unsafe_dynamic';
            const expected = unsafe ? focusCapacity.expectedUnsafeCount : focusCapacity.expectedCount;
            const maximum = unsafe ? focusCapacity.maxUnsafeDynamicRules : focusCapacity.maxDynamicRules;
            return {
              success: false,
              error: `Browser ${unsafe ? 'unsafe dynamic' : 'dynamic'} rule limit reached (${expected}/${maximum})`,
              code: 'dnr_rule_limit_reached'
            };
          }

          const previousFocusSession = await getFocusSessionState();
          const previousFocusAlarm = previousFocusSession.focusActive
            ? { scheduledTime: previousFocusSession.focusEndTime }
            : null;
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          await dailyLimitTracker.sample('focus_start_before');
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          await browser.storage.local.set({ focusSession: nextFocusSession });
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          await browser.alarms.create('end_focus_session', { when: endTime });
          await dailyLimitTracker.sample('focus_start_after');
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          const syncResult = await dnrSynchronizer.requestSync();
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;
          if (syncResult?.success === false) {
            await browser.storage.local.set({ focusSession: previousFocusSession });
            if (transitionGeneration !== focusSessionTransitionGeneration) return false;

            if (previousFocusAlarm) {
              const previousEndTime = Number(
                previousFocusAlarm.scheduledTime ?? previousFocusAlarm.when ??
                previousFocusSession.focusEndTime
              );
              if (Number.isFinite(previousEndTime) && previousEndTime > 0) {
                await browser.alarms.create('end_focus_session', { when: previousEndTime });
              }
            } else {
              await browser.alarms.clear('end_focus_session');
            }
            if (transitionGeneration !== focusSessionTransitionGeneration) return false;

            await dailyLimitTracker.sample('focus_start_rollback');
            if (transitionGeneration !== focusSessionTransitionGeneration) return false;
            const restored = await dnrSynchronizer.requestSync();
            if (restored?.success === false) {
              logger.warn('Focus Session: Previous browser protection could not be restored:', restored.error);
            }

            const error = new Error(syncResult.error || 'Could not activate Focus Session protection');
            error.code = syncResult.code || 'dnr_sync_failed';
            throw error;
          }

          if (focusMode === 'whitelist') {
            await checkAllTabsAgainstWhitelist(
              () => transitionGeneration === focusSessionTransitionGeneration
            );
            if (transitionGeneration !== focusSessionTransitionGeneration) return false;
          }

          logger.log(`Focus Session: Started for ${durationMinutes} minutes (mode: ${focusMode}).`);
          await Promise.all([
            diagnosticStore.recordEvent('info', 'focus', 'session_started', {
              durationMinutes,
              focusMode,
              isHardcore
            }),
            telemetryStore.incrementCounter('focus_started')
          ]);
          return true;
        });
        if (completed && typeof completed === 'object') {
          sendResponse(completed);
          return;
        }
        sendResponse({ success: true, ...(completed ? {} : { superseded: true }) });
      } catch (error) {
        logger.error('Focus Session: Error starting session:', error);
        const outcomes = await Promise.allSettled([
          diagnosticStore.recordEvent('error', 'focus', 'start_failed', { error }),
          telemetryStore.recordError({
            source: 'focus', code: 'start_failed', operation: 'start_session', errorName: error?.name || 'Error'
          })
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            logger.info('Focus start failure reporting could not be persisted:', outcome.reason);
          }
        }
        sendResponse({
          success: false,
          error: error.message,
          ...(error.code ? { code: error.code } : {})
        });
      }
    })();
    return true;
  }
  
  if (message.type === 'stop_focus_session') {
    const transitionGeneration = ++focusSessionTransitionGeneration;
    (async () => {
      try {
        const completed = await enqueueFocusSessionTransition(async () => {
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          await dailyLimitTracker.sample('focus_stop_before');
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          await browser.storage.local.set({
            focusSession: { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' }
          });
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          await dailyLimitTracker.sample('focus_stop_after');
          await browser.alarms.clear('end_focus_session');
          await dnrSynchronizer.requestSync();
          logger.log('Focus Session: Stopped by user.');
          await Promise.all([
            diagnosticStore.recordEvent('info', 'focus', 'session_stopped', {
              reason: 'user'
            }),
            telemetryStore.incrementCounter('focus_stopped')
          ]);
          return true;
        });
        sendResponse({ success: true, ...(completed ? {} : { superseded: true }) });
      } catch (error) {
        logger.error('Focus Session: Error stopping session:', error);
        await Promise.all([
          diagnosticStore.recordEvent('error', 'focus', 'stop_failed', { error }),
          telemetryStore.recordError({
            source: 'focus', code: 'stop_failed', operation: 'stop_session', errorName: error?.name || 'Error'
          })
        ]);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  
  if (message.type === 'permissions_granted') {
    logger.log("Permissions granted via onboarding.");
    dnrSynchronizer.requestSync();
  }
  
  if (message.type === 'delete_all_rules') {
    (async () => {
      try {
        const result = await rulesMutationService.clearRules();
        sendResponse({ success: true, ...result });
      } catch (error) {
        sendResponse({
          success: false,
          error: serializeRulesMutationError(error)
        });
      }
    })();
    return true;
  }
});

if (globalThis.addEventListener) {
  globalThis.addEventListener('error', event => {
    void telemetryStore.recordError({
      source: 'worker',
      code: 'uncaught_error',
      operation: 'service_worker',
      errorName: event?.error?.name || 'Error'
    });
  });

  globalThis.addEventListener('unhandledrejection', event => {
    void telemetryStore.recordError({
      source: 'worker',
      code: 'unhandled_rejection',
      operation: 'service_worker',
      errorName: event?.reason?.name || 'Error'
    });
  });
}

async function runDailyMaintenanceStep(name, operation) {
  try {
    return await operation();
  } catch (error) {
    logger.error(`Daily license maintenance: ${name} failed:`, error);
    return null;
  }
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check_pro_expiry') {
    await runDailyMaintenanceStep('uninstall URL update', updateUninstallURL);
    await runDailyMaintenanceStep('license verification', syncLicenseKeyStatus);
    await runDailyMaintenanceStep('context menu refresh', async () => {
      await enqueueProStatusTransition(async () => {
        const access = await ProManager.getAccess();
        await updateContextMenu(access.isPro || access.isLegacyUser);
      });
    });
    await runDailyMaintenanceStep('telemetry delivery', () => telemetryClient.flush());
  }

  if (alarm.name === TELEMETRY_RETRY_ALARM) {
    await telemetryClient.flush();
  }
  
  if (alarm.name === 'end_focus_session') {
    await reconcileFocusSession('alarm', {
      expectedEndTime: alarm.scheduledTime,
      allowEarlyCompletion: true
    });
  }
  
  if (alarm.name === DAILY_LIMIT_DEADLINE_ALARM) {
    await dailyLimitTracker.sample('deadline_alarm');
  }

  if (alarm.name === 'update_scheduled_rules') {
    await reconcileFocusSession('minute_alarm');
    if (await recoverPendingDailyUsage('minute_alarm')) {
      await dailyLimitTracker.sample('minute_alarm');
    }
    await Promise.all([
      dnrSynchronizer.requestSync({ reconcileExistingTabs: false }),
      checkAndRequestPermissions({ reason: 'scheduled_alarm' })
    ]);
  }
});

function ensureAlarmsCreated() {
  browser.alarms.get('check_pro_expiry', (alarm) => {
    if (!alarm) {
      browser.alarms.create('check_pro_expiry', {
        delayInMinutes: 0.5,
        periodInMinutes: 1440
      });
    }
  });
  
  browser.alarms.get('update_scheduled_rules', (alarm) => {
    if (!alarm) {
      browser.alarms.create('update_scheduled_rules', {
        periodInMinutes: 1
      });
    }
  });
}

ensureAlarmsCreated();
