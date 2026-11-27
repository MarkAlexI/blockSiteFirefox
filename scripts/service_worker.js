import { installWorkerErrorReporting } from '../telemetry/workerErrorReporter.js';
import { createProGuidanceController } from '../options/proGuidanceController.js';
import { RulesManager } from '../rules/rulesManager.js';
import { SettingsManager } from '../options/settings.js';
import { StatisticsManager } from '../pro/statisticsManager.js';
import { ProManager, getLicenseDataConsent } from '../pro/proManager.js';
import { closeTabsMatchingRules, closeNonWhitelistedTabs, closeNonWhitelistedTab } from './closeTabs.js';
import { normalizeDomainRule } from '../rules/normalizeDomainRule.js';
import { normalizePathRule } from '../rules/normalizePathRule.js';
import Logger from '../utils/logger.js';
import { resolveContextTarget } from '../utils/resolveContextTarget.js';
import { VERIFY_API_URL, IS_FIREFOX, LICENSE_SYNC_TIMEOUT_MS, MAX_RULES_LIMIT } from '../utils/constants.js';
import { updateUninstallURL } from '../utils/updateUninstallURL.js';
import { openInstallPage } from '../utils/createInstallURL.js';
import { shouldSkipSync } from '../utils/shouldSkipSync.js';
import { isBlockedURL } from './isBlockedURL.js';
import { getFocusSessionState, createFocusRecoveryTrace } from '../utils/focusSession.js';
import { POMODORO_KEY, POMODORO_ALARM, POMODORO_LOCK_ALARM, POMODORO_AUTO_GRACE_MS, hardenPomodoro, isPomodoroHardcoreLocked, normalizePomodoroConfig, readPomodoro, startPomodoro, matchesPomodoroWork, completePomodoroWork, nextPomodoroWork, readyPomodoro } from '../utils/focusSession.js';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';
import { createDnrSynchronizer, getDnrSyncFailureCode } from './dnrSynchronizer.js';
import { createSpaNavigationEnforcer } from './spaNavigationEnforcer.js';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { authorizeRedirect, createRedirectNavigationGuard } from '../utils/redirectAuthorization.js';
import { isRuleActiveNow } from '../rules/ruleActivation.js';
import { BLOCKING_MODE_DAILY_LIMIT } from '../rules/blockingMode.js';
import { getDailyUsageAssignmentKeys, getRuleAssignment, getRuleAssignments } from '../rules/ruleAssignments.js';
import { createRulesMigrationService } from '../rules/rulesMigrationService.js';
import { claimRulesMigrationNotice } from '../rules/rulesMigrationNotice.js';
import { GENERAL_RULE_LIST_ID, RuleListsManager } from '../rules/ruleListsManager.js';
import { DailyLimitManager } from '../rules/dailyLimitManager.js';
import { createDailyLimitTracker, DAILY_LIMIT_DEADLINE_ALARM, DAILY_LIMIT_VISIBILITY_MESSAGE,
  isDailyLimitVisibilitySender } from '../rules/dailyLimitTracker.js';
import { createRulesMutationService, serializeRulesMutationError } from '../rules/rulesMutationService.js';
import { RULES_INTENT_TYPES, createRulesIntentHandler } from '../rules/rulesIntentRouter.js';
import { resolveRulePackEntries } from '../rules/rulePacks.js';
import { createDnrSyncHealth } from '../diagnostics/dnrSyncHealth.js';
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
import { getRulePackTelemetryIncrements } from '../telemetry/telemetryRulePack.js';
import {
  ASYNC_HANDLER_OPERATIONS,
  createAsyncHandlerBoundary
} from '../telemetry/asyncHandlerBoundary.js';
import { createInstalledEventBoundary } from '../telemetry/installedEventBoundary.js';
import { FOCUS_SCHEDULE_ALARM } from '../schedules/focusSchedule.js';
import { createFocusScheduleController } from '../schedules/focusScheduleController.js';
import { BUILD_ID } from '../utils/buildInfo.js';
import { createSoundService } from '../utils/soundService.js';
import { createFocusSoundController, isSoundPreviewSender } from '../utils/focusSound.js';
import { createDailyLimitFocusPolicy } from '../utils/dailyLimitFocusPolicy.js';

const logger = new Logger('Worker');
const focusSound = createFocusSoundController({
  service: createSoundService({ api: browser }),
  getSettings: options => SettingsManager.getSettings(options)
});
const IS_RELEASE_CANDIDATE = /^RC\d+$/i.test(BUILD_ID);
const MANUAL_LICENSE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422]);
const rulesManager = new RulesManager();
const ruleListsManager = new RuleListsManager(browser.storage.local);
const dailyLimitManager = new DailyLimitManager(browser.storage.local, { sessionStorage: browser.storage.session });
let pendingDailyUsageRecovery = null;

async function getFocusAccess() {
  return ProManager.getAccess();
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

async function recordSpaNavigationDiagnostic(outcome) {
  if (!IS_RELEASE_CANDIDATE) return;

  try {
    await diagnosticStore.recordEvent('info', 'spa_navigation', 'url_change', {
      outcome
    });
  } catch (error) {
    logger.info('SPA navigation diagnostics could not be persisted:', error);
  }
}

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

const runAsyncHandler = createAsyncHandlerBoundary({
  recordError: error => telemetryStore.recordError(error),
  logger
});

const runInstalledEvent = createInstalledEventBoundary({
  recordError: error => telemetryStore.recordError(error),
  recordDiagnostic: ({ code, ...details }) =>
    diagnosticStore.recordEvent('error', 'worker', code, details),
  logger
});

const telemetryClient = createTelemetryClient({
  localStorage: browser.storage.local,
  permissionsApi: browser.permissions,
  store: telemetryStore,
  getContext: getCurrentTelemetryContext,
  scheduleRetry: async (when) => {
    await browser.alarms.clear(TELEMETRY_RETRY_ALARM);
    await browser.alarms.create(TELEMETRY_RETRY_ALARM, { when });
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

const RULE_LIST_ACTIVATION_INTENTS = new Set([
  'rules:activateList',
  'rules:toggleList'
]);

function getRuleIntentTelemetryIncrements(type, result) {
  if (type === 'rules:addMany') return getRulePackTelemetryIncrements(result);

  const increments = [];
  const counter = RULE_INTENT_COUNTERS.get(type);
  if (counter) increments.push([counter, 1]);

  if (type === 'rules:createList' && result?.ruleListCreated === true) {
    increments.push(['rule_list_created', 1]);
  }
  if (RULE_LIST_ACTIVATION_INTENTS.has(type) && result?.activeRuleListChanged === true) {
    increments.push(['rule_list_activated', 1]);
  }
  if ((type === 'rules:add' || type === 'rules:update') && result?.dailyLimitConfigured === true) {
    increments.push(['daily_limit_configured', 1]);
  }

  return increments;
}

async function recordRuleIntentTelemetry(type, result) {
  const telemetryTasks = getRuleIntentTelemetryIncrements(type, result)
    .map(([counter, amount]) => telemetryStore.incrementCounter(counter, amount));
  if (telemetryTasks.length > 0) await Promise.all(telemetryTasks);
}

async function settleRulesIntentPostCommitTasks(type, result) {
  const cleanupAndSample = (async () => {
    if (result.dailyUsageSyncPending) {
      pendingDailyUsageRecovery = true;
      if (!await recoverPendingDailyUsage('rules_intent', true)) return;
    }

    try {
      await dailyLimitManager.pruneAssignmentKeys(
        getDailyUsageAssignmentKeys(result.rules || [])
      );
    } catch (error) {
      logger.info('Rules post-commit Daily Limit cleanup failed:', error);
    }

    await dailyLimitTracker.observeMatchingPages();
    try {
      await dailyLimitTracker.sample('rules_intent');
    } catch (error) {
      // Keep spent counters, but never revive a pre-edit foreground segment
      // after an unrecorded mode boundary and charge time in another mode.
      await dailyLimitManager.discardLastSample();
      throw error;
    }
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

const dnrSyncHealth = createDnrSyncHealth({ diagnosticStore, telemetryStore });
let lastRecordedDnrFailureSignature = null;

function getDnrFailureSignature(result) {
  const failureCode = getDnrSyncFailureCode(result);
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

async function recordDnrSyncResult(result, metadata) {
  let recoveredHealth = false;
  try {
    recoveredHealth = (await dnrSyncHealth.record(result, metadata)).recovered;
  } catch (error) {
    logger.warn('DNR health observation could not be persisted:', error);
  }
  const failureCode = getDnrSyncFailureCode(result);
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
  const recoveredFromFailure = result.success && (recoveredHealth || lastRecordedDnrFailureSignature !== null);
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
        errorStage: result.errorStage || null,
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
        errorStage: result.errorStage || null,
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

// Protection decisions must not interpret an unreadable session as inactive.
const getFocusSessionForProtection = () => getFocusSessionState({ throwOnError: true });

const dnrSynchronizer = createDnrSynchronizer({
  getRules: getPreparedRules,
  getRuleListState: () => ruleListsManager.getState(),
  getDailyUsage: () => dailyLimitManager.getUsageSeconds(),
  getFocusSessionState: getFocusSessionForProtection,
  getAccess: getFocusAccess,
  isRuleActiveNow,
  createDnrRule,
  closeTabsMatchingRules: (patterns, shouldContinue) => {
    const generation = blockingDecisionGeneration;
    return closeTabsMatchingRules(patterns,
      () => shouldContinue() && generation === blockingDecisionGeneration);
  },
  declarativeNetRequest: browser.declarativeNetRequest,
  logger,
  onSyncResult: recordDnrSyncResult,
  onSyncRequested: invalidateBlockingDecisions
});

const spaNavigationEnforcer = createSpaNavigationEnforcer({
  tabsApi: browser.tabs,
  resolveNavigation: url => dnrSynchronizer.resolveNavigation(url),
  shouldSkipUrl: url => isBlockedURL([{ url }]),
  logger
});

const redirectNavigationGuard = createRedirectNavigationGuard({
  tabsApi: browser.tabs, runtimeApi: browser.runtime, sessionStorage: browser.storage.session
});

const requiresDailyLimitWindowFocus = createDailyLimitFocusPolicy({
  runtimeApi: browser.runtime, navigatorRef: globalThis.navigator || {}
});

const dailyLimitTracker = createDailyLimitTracker({
  tabsApi: browser.tabs,
  windowsApi: browser.windows,
  requiresWindowFocus: requiresDailyLimitWindowFocus,
  sessionStorage: browser.storage.session,
  scriptingApi: browser.scripting,
  alarmsApi: browser.alarms,
  getRules: getPreparedRules,
  getRuleListState: () => ruleListsManager.getState(),
  getFocusSessionState: getFocusSessionForProtection,
  dailyLimitManager,
  dnrSynchronizer,
  getStateGeneration: () => `${blockingDecisionGeneration}:${windowFocusGeneration}`,
  ensureStateReady: ensureRulesReady,
  logger
});

const rulesMigrationService = createRulesMigrationService({
  rulesManager,
  ruleListsManager,
  localStorage: browser.storage.local,
  syncStorage: browser.storage.sync,
  dailyLimitManager,
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
  getRulesGeneration: async () => (await browser.storage.local.get('rulesGeneration')).rulesGeneration ?? null,
  getSettings: () => SettingsManager.getSettings(),
  saveSettings: (settings) => browser.storage.sync.set({ settings }),
  saveRulesAndLists: async (rules, ruleLists, activeRuleListId, rulesGeneration, ruleRevisions, ruleListRevisions) => {
    const patch = await ruleListsManager.prepareState(ruleLists, activeRuleListId, {
      ...(rulesGeneration !== undefined ? { rulesGeneration } : {}),
      ...(ruleListRevisions !== undefined ? { ruleListRevisions } : {})
    });
    await rulesManager.saveRules(rules, { ...patch, ...(ruleRevisions !== undefined ? { ruleRevisions } : {}) });
  },
  maxRulesLimit: MAX_RULES_LIMIT,
  notifyRulesChanged,
  resolveRulePackEntries,
  logger
});

const handleRulesIntent = createRulesIntentHandler(rulesMutationService);

// Only local rule preparation joins this promise. Network/license checks and
// optional maintenance must not hold early event handlers behind startup.
let preparedRules = false;
let preparedRulesMigrated = false;
let rulesPreparationPromise = null;
function ensureRulesReady() {
  if (preparedRules) return Promise.resolve();
  if (!rulesPreparationPromise) {
    rulesPreparationPromise = rulesMutationService.runExclusive(async () => {
      const stored = await browser.storage.local.get(['rules', 'is_migrated_to_local']);
      if (!stored.is_migrated_to_local && !(Array.isArray(stored.rules) && stored.rules.length)) {
        preparedRulesMigrated = await rulesMigrationService.migrateToLocalForDevice({ throwOnError: true });
      }
      preparedRules = true;
    }).catch(error => {
      throw Object.assign(new Error('Local rules are not ready'), { code: 'rules_not_ready', cause: error });
    }).finally(() => { rulesPreparationPromise = null; });
  }
  return rulesPreparationPromise;
}

async function getPreparedRules() {
  await ensureRulesReady();
  return rulesManager.getRules();
}

/**
 * Checks a single tab URL against active Whitelist rules during 'whitelist' Focus Session.
 * Closes the tab if the URL is not whitelisted and is not a system/extension page.
 */
async function enforceFocusWhitelist(tabId, tabUrl) {
  if (isBlockedURL([{ url: tabUrl }])) {
    return false;
  }

  await ensureRulesReady();
  const transitionGeneration = focusSessionTransitionGeneration;
  const blockingGeneration = blockingDecisionGeneration;
  const shouldContinue = () => transitionGeneration === focusSessionTransitionGeneration &&
    blockingGeneration === blockingDecisionGeneration;
  
  const { focusActive, focusMode } = await getFocusSessionState();
  if (!shouldContinue() || !focusActive || focusMode !== 'whitelist') {
    return false;
  }
  
  const rules = await getPreparedRules();
  if (!shouldContinue()) return false;
  const whitelistRules = rules.filter(r =>
    r.isWhitelist && getRuleAssignment(r, GENERAL_RULE_LIST_ID)?.disabledByUser !== true
  );
  
  if (!isUrlInWhitelist(tabUrl, whitelistRules)) {
    const currentSession = await getFocusSessionState();
    if (
      !shouldContinue() ||
      currentSession.focusActive !== true ||
      currentSession.focusMode !== 'whitelist'
    ) return false;

    const currentRules = await getPreparedRules();
    if (!shouldContinue()) return false;
    const currentWhitelistRules = currentRules.filter(r =>
      r.isWhitelist && getRuleAssignment(r, GENERAL_RULE_LIST_ID)?.disabledByUser !== true
    );
    if (isUrlInWhitelist(tabUrl, currentWhitelistRules)) return true;

    await closeNonWhitelistedTab(tabId, tabUrl, currentWhitelistRules, shouldContinue);
  }

  return true;
}

/**
 * Scans all currently open tabs and closes any tab that does not match active Whitelist rules.
 */
async function checkAllTabsAgainstWhitelist(shouldContinue = () => true) {
  const generation = blockingDecisionGeneration;
  const isCurrent = () => shouldContinue() && generation === blockingDecisionGeneration;
  if (!isCurrent()) return;
  const rules = await getPreparedRules();
  if (!isCurrent()) return;
  const whitelistRules = rules.filter(r =>
    r.isWhitelist && getRuleAssignment(r, GENERAL_RULE_LIST_ID)?.disabledByUser !== true
  );
  
  await closeNonWhitelistedTabs(whitelistRules, isCurrent);
}

let blockingDecisionGeneration = 0;
let windowFocusGeneration = 0;
function invalidateBlockingDecisions() {
  blockingDecisionGeneration += 1;
  spaNavigationEnforcer.invalidate();
}

// Storage events also cover changes originating in another extension page or
// sync. They invalidate delayed decisions without adding background polling.
browser.storage.onChanged.addListener((changes, areaName) => {
  const keys = areaName === 'local'
    ? ['rules', 'ruleLists', 'activeRuleListId', 'focusSession']
    : areaName === 'sync' ? ['credentials'] : [];
  const usageChange = areaName === 'local' ? changes.dailyRuleUsage : null;
  // Sample timestamps and initializing an empty usage map do not change a
  // blocking decision. Avoid invalidating a read that initialized that map.
  const usageChanged = usageChange && JSON.stringify(usageChange.oldValue?.usageSeconds || {}) !==
    JSON.stringify(usageChange.newValue?.usageSeconds || {});
  if (usageChanged || keys.some(key => Object.hasOwn(changes, key))) {
    invalidateBlockingDecisions();
    dnrSynchronizer.invalidateState();
  }
});

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

// Lock order: state transition -> rules mutation -> daily usage. Network
// license verification remains outside this queue; only its commit joins it.
function enqueueStateTransition(task) {
  const run = async () => {
    await ensureRulesReady();
    return task();
  };
  const result = stateTransitionTail.then(run, run);
  stateTransitionTail = result.catch(() => {});
  return result;
}

const proGuidanceController = createProGuidanceController({
  storage: browser.storage.local,
  getAccess: () => ProManager.getAccess(),
  runExclusive: enqueueStateTransition
});

function enqueueProStatusTransition(task) {
  return enqueueStateTransition(task);
}

function enqueueFocusSessionTransition(task) {
  return enqueueStateTransition(task);
}

function enqueueRulesTransition(task) {
  return enqueueStateTransition(async () => {
    const cycle = await readCurrentPomodoro();
    if (isPomodoroHardcoreLocked(cycle)) {
      throw Object.assign(new Error('Hardcore Pomodoro is locked'), { code: 'hardcore_active' });
    }
    invalidateBlockingDecisions();
    return task();
  });
}

async function runFocusCompletionTask(name, operation) {
  try {
    return await operation();
  } catch (error) {
    logger.error(`Focus Session recovery: ${name} failed:`, error);
    return null;
  }
}

async function reportFocusRecoveryFailure(reason, error, { phase = 'unknown', scheduled = false } = {}) {
  const code = phase === 'unknown' ? (scheduled ? 'schedule_recovery_failed' : 'recovery_failed')
    : `${scheduled ? 'schedule' : 'recovery'}_${phase}_failed`;
  const outcomes = await Promise.allSettled([
    diagnosticStore.recordEvent('error', 'focus', code, { reason, phase, error }),
    telemetryStore.recordError({
      source: 'focus',
      code,
      operation: scheduled ? 'scheduled_alarm' : 'recover_session',
      errorName: error?.name || 'Error'
    })
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      logger.info('Focus recovery failure reporting could not be persisted:', outcome.reason);
    }
  }
}

function getAlarm(name) {
  let result;
  try {
    result = browser.alarms.get(name);
  } catch (_) {
    result = undefined;
  }

  if (result && typeof result.then === 'function') return result;
  if (result !== undefined) return Promise.resolve(result);

  return new Promise((resolve, reject) => {
    try {
      browser.alarms.get(name, alarm => {
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

async function ensureFocusCompletionAlarm(endTime, shouldContinue, step) {
  const existing = await step('alarm_read', () => getAlarm(FOCUS_COMPLETION_ALARM));
  if (!shouldContinue()) return false;

  const scheduledTime = Number(existing?.scheduledTime ?? existing?.when);
  if (Number.isFinite(scheduledTime) && Math.abs(scheduledTime - endTime) <= 1000) {
    return false;
  }

  await step('alarm_create', () => browser.alarms.create(FOCUS_COMPLETION_ALARM, { when: endTime }));
  return true;
}

async function showFocusCompletionNotification(messageKey = 'focussessionended') {
  if (!browser.notifications) return;
  await browser.notifications.create('focus_session_ended', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('images/icon-192.png'),
    title: browser.i18n.getMessage('focussessionheader'),
    message: browser.i18n.getMessage(messageKey),
    priority: 2
  });
}

async function reconcileStoredFocusSession(reason, {
  transitionGeneration,
  expectedEndTime = null,
  allowEarlyCompletion = false,
  rearmFuture = true,
  invalidateGeneration = true,
  step = (_phase, operation) => operation(),
  shouldContinue = () => transitionGeneration === focusSessionTransitionGeneration
} = {}) {
  if (!shouldContinue()) return { status: 'superseded' };

  const result = await step('state_read', () => browser.storage.local.get(['focusSession']));
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
      const alarmCreated = await ensureFocusCompletionAlarm(endTime, shouldContinue, step);
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

  const cycle = readPomodoro((await browser.storage.local.get(POMODORO_KEY))[POMODORO_KEY]);
  if (!shouldContinue()) return { status: 'superseded' };
  const cycleWork = hasValidEndTime && matchesPomodoroWork(cycle, focusSession);
  const nextCycle = cycleWork ? completePomodoroWork(cycle, now) : null;
  await step('state_write', () => browser.storage.local.set({ focusSession: { ...INACTIVE_FOCUS_SESSION },
    ...(cycleWork ? { [POMODORO_KEY]: nextCycle } : {}) }));
  if (cycleWork) await runFocusCompletionTask('Pomodoro break alarm', () => armPomodoro(nextCycle));
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
    runFocusCompletionTask('DNR synchronization', () => dnrSynchronizer.requestSync({ trigger: 'focus_complete' }))
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

  // A recovery interval clipped by the fixed Hardcore deadline is not a full work interval.
  if (cycleWork && cycle.isHardcore && Number.isFinite(cycle.workStartedAt) &&
      endTime - cycle.workStartedAt < cycle.workMinutes * 60_000) {
    return { status: 'partial_pomodoro_finished' };
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
  // Feedback is best effort after the durable completion. Audio/notification
  // failures and slow platform replies must not hold the state mutation queue.
  void runFocusCompletionTask('completion notification', () => showFocusCompletionNotification(
    cycleWork ? (nextCycle ? (nextCycle.phase === 'ready' ? 'pomodoro_ready' : 'pomodoro_break') :
      cycle.completedRounds + 1 >= cycle.rounds ? 'pomodoro_complete' : 'focussessionended') : 'focussessionended'));
  void runFocusCompletionTask('completion sound', () => focusSound.complete(endTime));
  return { status: 'completed' };
}

async function reconcileFocusSession(reason, options = {}) {
  const trace = createFocusRecoveryTrace();
  const transitionGeneration = focusSessionTransitionGeneration;
  try {
    return await enqueueFocusSessionTransition(() => reconcileStoredFocusSession(reason, {
      ...options,
      transitionGeneration,
      invalidateGeneration: true,
      step: trace.step
    }));
  } catch (error) {
    logger.error(`Focus Session recovery failed (${reason}):`, error);
    await reportFocusRecoveryFailure(reason, error, { phase: trace.getPhase(error) });
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

async function activateFocusSession(request, transitionGeneration, scheduledEndTime = null, isScheduledWindowCurrent = null, cycle = undefined, canBeSuperseded = true) {
  const shouldContinue = () => !canBeSuperseded || transitionGeneration === focusSessionTransitionGeneration;
  if (!shouldContinue()) return false;

  await reconcileStoredFocusSession('focus_start', {
    transitionGeneration,
    shouldContinue,
    rearmFuture: false,
    invalidateGeneration: false
  });
  if (!shouldContinue()) return false;

  const { durationMinutes, isHardcore, focusMode } = request;
  const access = await getFocusAccess();
  if (!shouldContinue()) return false;
  if (
    !access.isPro &&
    !access.isLegacyUser &&
    (scheduledEndTime !== null || durationMinutes !== 25 || isHardcore || focusMode !== 'blacklist')
  ) {
    return { success: false, error: 'pro_required', code: 'pro_required' };
  }

  const endTime = cycle?.isHardcore ? cycle.phaseEndTime :
    scheduledEndTime ?? (Date.now() + durationMinutes * 60 * 1000);
  if (Date.now() >= endTime) return false;
  const nextFocusSession = {
    focusActive: true,
    focusEndTime: endTime,
    isHardcore,
    focusMode,
    ...(cycle ? { pomodoroId: cycle.id } : {})
  };
  if (cycle) cycle = { ...cycle, phaseEndTime: endTime };
  const focusCapacity = await dnrSynchronizer.validateRuleCapacity(
    null,
    null,
    nextFocusSession,
    access
  );
  if (!shouldContinue()) return false;
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

  const previousCycle = cycle === undefined ? undefined : (await browser.storage.local.get(POMODORO_KEY))[POMODORO_KEY] ?? null;
  const previousFocusSession = await getFocusSessionForProtection();
  const previousFocusAlarm = previousFocusSession.focusActive
    ? { scheduledTime: previousFocusSession.focusEndTime }
    : null;
  if (!shouldContinue()) return false;

  await dailyLimitTracker.sample('focus_start_before');
  if (!shouldContinue()) return false;

  if (Date.now() >= endTime || (isScheduledWindowCurrent && !isScheduledWindowCurrent())) return false;
  // Once this write starts, finish protection or rollback while holding the state queue.
  // A later request may still be rejected and cannot own a partially saved session.
  try {
    await browser.storage.local.set({ focusSession: nextFocusSession,
      ...(cycle === undefined ? {} : { [POMODORO_KEY]: cycle }) });

    await browser.alarms.create('end_focus_session', { when: endTime });
    if (cycle) await armPomodoro(cycle);
    await dailyLimitTracker.sample('focus_start_after');

    const syncResult = await dnrSynchronizer.requestSync({ trigger: 'focus_start' });
    if (syncResult?.success === false) {
      throw Object.assign(new Error(syncResult.error || 'Could not activate Focus Session protection'), {
        code: syncResult.code || 'dnr_sync_failed'
      });
    }
  } catch (error) {
    await browser.storage.local.set({ focusSession: previousFocusSession,
      ...(cycle === undefined ? {} : { [POMODORO_KEY]: previousCycle }) });

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

    if (cycle !== undefined) await armPomodoro(readPomodoro(previousCycle));
    await dailyLimitTracker.sample('focus_start_rollback');
    const restored = await dnrSynchronizer.requestSync({ trigger: 'focus_rollback' });
    if (restored?.success === false) {
      logger.warn('Focus Session: Previous browser protection could not be restored:', restored.error);
    }
    throw error;
  }

  if (focusMode === 'whitelist') {
    await checkAllTabsAgainstWhitelist();
  }

  logger.log(`Focus Session: Started for ${durationMinutes} minutes (mode: ${focusMode}).`);
  await Promise.allSettled([
    diagnosticStore.recordEvent('info', 'focus', 'session_started', {
      durationMinutes,
      focusMode,
      isHardcore
    }),
    telemetryStore.incrementCounter('focus_started')
  ]);
  return shouldContinue();
}

// A rejected intent may have superseded activation after its durable write.
// Finish protection for that saved session before returning the rejection.
async function preserveActiveFocus(focus, generation) {
  const current = () => generation === focusSessionTransitionGeneration;
  await ensureFocusCompletionAlarm(focus.focusEndTime, current, (_phase, operation) => operation());
  if (current()) await armPomodoro(await readCurrentPomodoro());
  if (!current()) return;
  await dnrSynchronizer.requestSync({ trigger: 'focus_preserve' });
  if (focus.focusMode === 'whitelist' && current()) await checkAllTabsAgainstWhitelist(current);
}

async function readCurrentPomodoro() {
  const stored = (await browser.storage.local.get(POMODORO_KEY))[POMODORO_KEY];
  const cycle = readPomodoro(stored);
  const current = hardenPomodoro(cycle);
  if (current && JSON.stringify(current) !== JSON.stringify(cycle)) {
    await browser.storage.local.set({ [POMODORO_KEY]: current });
  }
  return current;
}

async function armPomodoro(cycle) {
  if (isPomodoroHardcoreLocked(cycle)) {
    const deadline = await getAlarm(POMODORO_LOCK_ALARM);
    if (Math.abs(Number(deadline?.scheduledTime ?? deadline?.when ?? 0) - cycle.hardcoreEndTime) > 1000) {
      await browser.alarms.create(POMODORO_LOCK_ALARM, { when: cycle.hardcoreEndTime });
    }
  } else await browser.alarms.clear(POMODORO_LOCK_ALARM);
  if (cycle?.phase !== 'break') {
    await browser.alarms.clear(POMODORO_ALARM);
    return;
  }
  const alarm = await getAlarm(POMODORO_ALARM);
  if (!Number.isFinite(Number(alarm?.scheduledTime ?? alarm?.when)) || Math.abs(Number(alarm?.scheduledTime ?? alarm?.when) - cycle.phaseEndTime) > 1000) {
    await browser.alarms.create(POMODORO_ALARM, { when: cycle.phaseEndTime });
  }
}

async function continuePomodoroStored(cycle, generation, scheduledStart = null, canBeSuperseded = true) {
  if (cycle.isHardcore && Date.now() >= cycle.hardcoreEndTime) return { success: false, code: 'pomodoro_changed' };
  const next = nextPomodoroWork(cycle, cycle.isHardcore && scheduledStart !== null ? scheduledStart : Date.now());
  const result = await activateFocusSession({ durationMinutes: next.workMinutes,
    isHardcore: next.isHardcore, focusMode: next.focusMode }, generation, null, null, next, canBeSuperseded);
  if (result === true) await browser.alarms.clear(POMODORO_ALARM);
  return result;
}

async function reconcilePomodoro(reason, expectedEndTime = null) {
  const generation = focusSessionTransitionGeneration;
  try {
    return await enqueueFocusSessionTransition(async () => {
      if (generation !== focusSessionTransitionGeneration) return;
      const stored = await browser.storage.local.get([POMODORO_KEY, 'focusSession']);
      if (generation !== focusSessionTransitionGeneration) return;
      const cycle = await readCurrentPomodoro();
      if (!cycle) { await armPomodoro(null); return; }
      if (cycle.isHardcore && Date.now() >= cycle.hardcoreEndTime) {
        // Reconcile only the work that was actually started; never replay later rounds.
        if (stored.focusSession?.pomodoroId === cycle.id) {
          await reconcileStoredFocusSession('pomodoro_deadline', {
            transitionGeneration: generation, invalidateGeneration: false
          });
        }
        if (generation !== focusSessionTransitionGeneration) return;
        await browser.storage.local.set({ [POMODORO_KEY]: null });
        await armPomodoro(null);
        return;
      }

      if (cycle.phase === 'work') {
        // A partial or corrupted state must not strand an invisible cycle.
        if (!matchesPomodoroWork(cycle, stored.focusSession)) {
          await browser.storage.local.set({ [POMODORO_KEY]: isPomodoroHardcoreLocked(cycle) ? readyPomodoro(cycle) : null });
        }
        await armPomodoro(cycle);
        return;
      }
      if (cycle.phase !== 'break' || Date.now() < cycle.phaseEndTime) {
        await armPomodoro(cycle);
        return;
      }
      if (expectedEndTime !== null && Math.abs(expectedEndTime - cycle.phaseEndTime) > 1000) return;
      const ready = readyPomodoro(cycle);
      // Commit the waiting state BEFORE activation: a crash cannot replay an auto-start.
      await browser.storage.local.set({ [POMODORO_KEY]: ready });
      await armPomodoro(ready);
      // Finish this claimed transition before evaluating queued manual intents.
      // Rejecting a stale End must not leave an auto cycle stranded in ready.
      if (cycle.autoContinue) {
        // Recheck at every automatic transition, including restored cycles.
        const access = await getFocusAccess();
        if (!access.isPro && !access.isLegacyUser) {
          await browser.storage.local.set({ [POMODORO_KEY]: { ...ready, autoContinue: false } });
        } else if (Date.now() - cycle.phaseEndTime <= POMODORO_AUTO_GRACE_MS) {
          await continuePomodoroStored(ready, generation, cycle.phaseEndTime, false);
          return;
        }
      }
      void runFocusCompletionTask('Pomodoro break notification', () => showFocusCompletionNotification('pomodoro_ready'));
    });
  } catch (error) {
    logger.error('Pomodoro recovery failed:', error);
    await diagnosticStore.recordEvent('error', 'focus', 'pomodoro_recovery_failed', { reason, error });
    return { status: 'failed' };
  }
}

const focusScheduleController = createFocusScheduleController({
  storage: browser.storage.local,
  alarms: browser.alarms,
  getAccess: getFocusAccess,
  getSession: async () => {
    const [session, stored] = await Promise.all([getFocusSessionForProtection(), browser.storage.local.get(POMODORO_KEY)]);
    return { ...session, focusActive: session.focusActive || Boolean(readPomodoro(stored[POMODORO_KEY])) };
  },
  runExclusive: enqueueFocusSessionTransition,
  startSession: (occurrence, transitionGeneration, isCurrentWindow) => activateFocusSession({
    durationMinutes: (occurrence.endTime - occurrence.startTime) / 60_000,
    isHardcore: false, focusMode: 'blacklist'
  }, transitionGeneration, occurrence.endTime, isCurrentWindow)
});

async function reconcileScheduledFocus(reason = 'worker_load') {
  await reconcilePomodoro(reason);
  const trace = createFocusRecoveryTrace();
  const generation = focusSessionTransitionGeneration;
  let failurePhase;
  try {
    const result = await focusScheduleController.reconcile(generation, trace.step);
    if (result?.success === false) {
      failurePhase = 'activation';
      throw Object.assign(new Error(result.error), { code: result.code });
    }
  } catch (error) {
    logger.error('Scheduled Focus Session failed:', error);
    await reportFocusRecoveryFailure(reason, error, { phase: failurePhase || trace.getPhase(error), scheduled: true });
  }
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

  if (
    !result.success &&
    result.reason !== 'no_key' &&
    result.reason !== 'consent_required'
  ) {
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

  const licenseConsent = await getLicenseDataConsent(browser.permissions);
  if (!licenseConsent.enabled) {
    throw createLicenseActivationError(
      'License verification consent is required',
      'license_consent_required'
    );
  }

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
      const code = MANUAL_LICENSE_REJECTION_STATUSES.has(response.status)
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
        { licenseKey: null, expiryDate: null },
        { expectedLicenseKey: null, verificationGeneration }
      );
      if (!updated) return finishSupersededLicenseCheck();
    }
    return finishLicenseCheck({ success: false, isPro: false, reason: 'no_key' });
  }

  const licenseConsent = await getLicenseDataConsent(browser.permissions);
  if (!licenseConsent.enabled) {
    logger.log('License Sync: Authentication-data permission is not granted, skipping sync.');
    return finishLicenseCheck({
      success: false,
      isPro: credentials.isPro === true,
      reason: 'consent_required'
    });
  }
  
  logger.log('License Sync: Checking stored key...');
  const version = browser.runtime.getManifest().version;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LICENSE_SYNC_TIMEOUT_MS);
  
  try {
    const response = await fetch(VERIFY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: currentKey, version }),
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
        expiryDate: null
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
      expiryDate: data.expiryDate,
      // Payment suspension must remain verifiable after the customer pays.
      // Explicit logout, HTTP rejection and revoked/unknown keys still clear it.
      preserveLicenseKey: data.isPro === false && data.licenseValid !== false
    }, { expectedLicenseKey: currentKey, verificationGeneration });
    if (!updated) return finishSupersededLicenseCheck();
    
    logger.log('License Sync: Status updated from server. isPro:', data.isPro);
    return finishLicenseCheck({ success: true, isPro: data.isPro, reason: 'verified',
      ...(updated.syncPending ? { syncPending: true } : {}) });
    
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
  browser.contextMenus.onClicked.addListener((info, tab) =>
    runAsyncHandler(ASYNC_HANDLER_OPERATIONS.CONTEXT_MENU_ADD, async () => {
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
      const created = await enqueueRulesTransition(async () => {
        // The initial UI check can precede a queued logout.
        if (!await ProManager.hasPaidAccess()) return false;
        const listSnapshot = await ruleListsManager.getSnapshot();
        await rulesMutationService.addRule({
          expectedGeneration: listSnapshot.generation,
          expectedListRevisions: listSnapshot.revisions,
          blockURL: ruleValue,
          redirectURL: '',
          schedule: null,
          category: 'social',
          isWhitelist: false
        });
        return true;
      });
      if (!created) return;
      
      logger.log(
        `Blocked ${target.type} via Context Menu:`,
        ruleValue
      );
      await telemetryStore.incrementCounter('rule_created');
      
    } catch (error) {
      logger.info('Error processing context menu block:', error);
    }
    })
  );
}

async function showUpdates(details) {
  const version = browser.runtime.getManifest().version;
  if (!/\.0$/.test(version)) return true;

  let shouldOpenUpdate = details.reason === 'update';
  try {
    const settings = await SettingsManager.getSettings();
    shouldOpenUpdate = shouldOpenUpdate && settings.showNotifications === true;
  } catch (error) {
    logger.error('Error showing updates:', error);
  }

  if (shouldOpenUpdate) {
    try {
      await browser.tabs.create({
        url: browser.runtime.getURL(`update/update.html?version=${version}`)
      });
    } catch (error) {
      logger.info('Update page could not be opened:', error);
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

    const rules = await getPreparedRules();
    const syncResult = await dnrSynchronizer.requestSync({ trigger: 'license_change' });
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

    const cycle = await readCurrentPomodoro();
    if (cycle?.isHardcore && shouldContinue()) {
      const { hardcoreEndTime, workStartedAt, ...ordinary } = cycle;
      const downgraded = { ...ordinary, isHardcore: false, autoContinue: false };
      await browser.storage.local.set({ [POMODORO_KEY]: downgraded });
      await armPomodoro(downgraded);
    }
    const focusSession = await getFocusSessionState();
    if (!focusSession.focusActive || !shouldContinue()) return false;

    if (focusSession.focusMode === 'blacklist' && focusSession.isHardcore !== true) {
      if (!ruleListRestored && shouldContinue()) await dnrSynchronizer.requestSync({ trigger: 'license_change' });
      return false;
    }

    await browser.storage.local.set({
      focusSession: { ...focusSession, isHardcore: false, focusMode: 'blacklist' }
    });
    if (!shouldContinue()) return false;

    await dnrSynchronizer.requestSync({ trigger: 'license_change' });
    logger.log('Free access restored to the standard Focus Session');
    return true;
  };

  return alreadySerialized ? restore() : enqueueFocusSessionTransition(restore);
}

function handleProStatusUpdate(isPro, subscriptionData = {}, expectedVerification = null, { manual = false } = {}) {
  const transitionGeneration = expectedVerification
    ? proStatusTransitionGeneration
    : ++proStatusTransitionGeneration;

  if (!expectedVerification) licenseVerificationGeneration += 1;

  return enqueueProStatusTransition(async () => {
    try {
      if (manual && isPomodoroHardcoreLocked(await readCurrentPomodoro())) {
        throw Object.assign(new Error('Hardcore Pomodoro is locked'), { code: 'hardcore_active' });
      }
      await ProManager.initializeInstallationMetadata({
        fallbackInstallationDate: new Date().toISOString(), onlyIfMissing: true
      });
      const previousCredentials = await ProManager.getCredentials({ throwOnError: true });
      if (expectedVerification) {
        const credentials = previousCredentials;
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

      // Keep cleanup live when verification confirms unchanged access. Firefox
      // may deliver an equal-value storage event later; do not depend on it.
      // Other credential changes invalidate through storage.onChanged.
      if (previousCredentials.isPro !== isPro) invalidateBlockingDecisions();
      logger.log(`Service worker received Pro status update: ${isPro}`);
      const updatedCredentials = await ProManager.setProStatusFromWorker(isPro, subscriptionData);
      const shouldContinue = () => transitionGeneration === proStatusTransitionGeneration &&
        (!expectedVerification || expectedVerification.verificationGeneration === licenseVerificationGeneration);
      if (!shouldContinue()) return expectedVerification ? null : updatedCredentials;

      const ruleListRestored = await restoreFreeRuleListAccess(shouldContinue);
      if (!shouldContinue()) return expectedVerification ? null : updatedCredentials;

      await restoreFreeFocusAccess(shouldContinue, {
        ruleListRestored,
        alreadySerialized: true
      });
      if (!shouldContinue()) return expectedVerification ? null : updatedCredentials;

      let syncPending = false;
      if (previousCredentials.isPro !== true && updatedCredentials.isPro === true) {
        // Returning paid access can expand an active Focus Session beyond
        // General. Invalidating cached state alone does not start an idle sync.
        try {
          const syncResult = await dnrSynchronizer.requestSync({ trigger: 'license_change' });
          syncPending = syncResult?.success === false;
        } catch (error) {
          logger.warn('Pro access restored; browser rule synchronization is pending:', error);
          syncPending = true;
        }
        if (!shouldContinue()) return expectedVerification ? null : updatedCredentials;
      }

      logger.log('Pro status updated successfully');
      await updateContextMenu(
        updatedCredentials.isPro === true || ProManager.resolveLegacyAccess(updatedCredentials)
      );
      if (!shouldContinue()) return expectedVerification ? null : updatedCredentials;
      return { ...updatedCredentials, ...(syncPending ? { syncPending: true } : {}) };
    } catch (error) {
      if (error.code !== 'hardcore_active') logger.error('Error handling Pro status update:', error);
      throw error;
    }
  });
}

const navigationEventTokens = new Map();
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const observedAt = new Date();
  const eventToken = {};
  if (changeInfo.url) navigationEventTokens.set(tabId, eventToken);
  return runAsyncHandler(ASYNC_HANDLER_OPERATIONS.TAB_UPDATED, async () => {
    if (changeInfo.status === 'complete' && tab.url) await redirectNavigationGuard.completed(tabId, tab.url);
    if (changeInfo.url) {
      const handledByWhitelistFocus = await enforceFocusWhitelist(tabId, changeInfo.url);
      // Retain local initialization/Whitelist ordering, then queue accounting
      // before the potentially delayed SPA decision. Keep the native event time.
      const accounting = tab.active ? runAsyncHandler(ASYNC_HANDLER_OPERATIONS.TAB_UPDATED,
        () => dailyLimitTracker.sample('tab_url_changed', observedAt, { ...tab, url: changeInfo.url })) : Promise.resolve();
      let spaOutcome = 'whitelist_focus';
      if (!handledByWhitelistFocus) {
        const result = await spaNavigationEnforcer.enforce(tabId, changeInfo.url);
        spaOutcome = result.status;
      }
      await recordSpaNavigationDiagnostic(spaOutcome);
      const sample = await accounting;
      // Startup migration can invalidate the first context while resolving
      // this event. Retry that boundary once after reconciliation, retaining
      // its timestamp; the manager rejects it if a newer sample already won.
      if (sample?.resolution === 'superseded' && navigationEventTokens.get(tabId) === eventToken) {
        await dailyLimitTracker.sample('tab_url_changed', observedAt, { ...tab, url: changeInfo.url });
      }
    }
    if (changeInfo.status === 'complete' && tab.url) {
      if (tab.active) await dailyLimitTracker.sample('tab_load_complete', observedAt, tab);
      await trackBlockedPage(tab.url);
    }
  });
});

browser.tabs.onRemoved?.addListener(tabId => {
  navigationEventTokens.delete(tabId);
  void redirectNavigationGuard.removed(tabId).catch(error => logger.info('Redirect tab cleanup failed:', error));
});

browser.tabs.onActivated.addListener((activeInfo) => {
  void browser.tabs.get(activeInfo.tabId)
    .then(tab => dailyLimitTracker.sample('tab_activated', new Date(), tab))
    .catch(error => logger.info('Daily limit tab activation sample failed:', error));
});

browser.windows?.onFocusChanged?.addListener(windowId => {
  const handleNativeFocus = () => {
    // Invalidate an in-flight visibility/focus read before its queued pause or
    // resume runs; an old native result must not reopen the previous segment.
    windowFocusGeneration += 1;
    return runAsyncHandler(ASYNC_HANDLER_OPERATIONS.WINDOW_FOCUS_CHANGED, async () => {
      if (windowId === browser.windows.WINDOW_ID_NONE) {
        await dailyLimitTracker.pause('window_focus_lost');
        return;
      }
      await dailyLimitTracker.sample('window_focus_gained');
    });
  };
  const required = requiresDailyLimitWindowFocus();
  if (typeof required === 'boolean') return required ? handleNativeFocus() : undefined;
  return required.then(value => value ? handleNativeFocus() : undefined);
});

browser.tabs.onCreated.addListener((tab) =>
  runAsyncHandler(ASYNC_HANDLER_OPERATIONS.TAB_CREATED, async () => {
    if (tab.id && tab.url) {
      await enforceFocusWhitelist(tab.id, tab.url);
      if (tab.active) await dailyLimitTracker.sample('tab_created', new Date(), tab);
    }

    if (tab.url && tab.url !== 'about:blank' && tab.url !== 'chrome://newtab/') {
      await trackBlockedPage(tab.url);
    }
  })
);

browser.runtime.onStartup.addListener(() =>
  runAsyncHandler(ASYNC_HANDLER_OPERATIONS.STARTUP, async () => {
    if (!browser.storage.session) await dailyLimitManager.discardLastSample();
    try {
      await telemetryClient.restoreRetry();
    } catch (error) {
      logger.info('Could not restore the telemetry retry on startup:', error);
    }

    await ensureAlarmsCreated();

    await initializeExtension({ reason: 'startup' });
    await checkAndRequestPermissions({ reason: 'startup' }, { notifyIfMissing: true });

    await runAsyncHandler(ASYNC_HANDLER_OPERATIONS.STARTUP,
      async () => {
        await dailyLimitTracker.observeMatchingPages();
        return dailyLimitTracker.sample('startup');
      });
    logger.log("Extension startup - syncing DNR rules");
    await dnrSynchronizer.requestSync({ trigger: 'startup' });

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
  })
);

async function initializeExtension(details) {
  // A failed device migration must not turn an empty snapshot into usage cleanup.
  await ensureRulesReady();
  logger.log("Initializing extension state (rules, settings, legacy status)...");
  const dailyUsageRecovered = await recoverPendingDailyUsage('startup', true);
  const migrationResult = await rulesMutationService.runExclusive(
    () => rulesMigrationService.migrateAll({
      skipDailyUsageMigration: !dailyUsageRecovered
    })
  );

  // Keep the lifecycle migration notice when early protection prepared rules first.
  if (preparedRulesMigrated) {
    migrationResult.migrated = migrationResult.userVisibleMigration = migrationResult.migratedFromSync = true;
    preparedRulesMigrated = false;
  }

  if (dailyUsageRecovered) {
    await dailyLimitManager.pruneAssignmentKeys(
      getDailyUsageAssignmentKeys(migrationResult.rules || [])
    );
  }

  if (migrationResult.userVisibleMigration) {
    await dnrSynchronizer.requestSync({ trigger: 'initialize' });

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
  await reconcileScheduledFocus(details.reason || 'initialize');
  await showUpdates(details);
  
  try {
    await enqueueProStatusTransition(async () => {
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
        await ProManager.initializeInstallationMetadata({
          fallbackInstallationDate: new Date().toISOString(), onlyIfMissing: true
        });
      }

      const ruleListRestored = await restoreFreeRuleListAccess();
      await restoreFreeFocusAccess(() => true, { ruleListRestored, alreadySerialized: true });
      const access = await ProManager.getAccess();
      await updateContextMenu(access.isPro || access.isLegacyUser);
    });
  } catch (error) {
    logger.info('Error handling install/update for legacy:', error);
  }

  // Internal usage recovery can change blocking with already canonical rules.
  // A visible migration already synced above; startup and browser updates
  // have their own sync/integrity step. Complete canonical install/update
  // with one explicit sync before an install page can observe the new state.
  if (!migrationResult.userVisibleMigration && ['install', 'update'].includes(details.reason)) {
    await dnrSynchronizer.requestSync({ trigger: 'initialize' });
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
  browser.permissions.onRemoved.addListener(permissions =>
    runAsyncHandler(ASYNC_HANDLER_OPERATIONS.PERMISSION_REMOVED, async () => {
    if (affectsRequiredHostAccess(permissions.origins)) {
      await checkAndRequestPermissions(
        { reason: 'permission_removed' },
        { notifyIfMissing: true, assumeMissing: true }
      );
    }

    if (affectsTelemetryConsent(permissions)) {
      await telemetryClient.setConsent(false);
    }
    })
  );
}

if (browser.permissions?.onAdded) {
  browser.permissions.onAdded.addListener(permissions =>
    runAsyncHandler(ASYNC_HANDLER_OPERATIONS.PERMISSION_ADDED, async () => {
    if (affectsRequiredHostAccess(permissions.origins)) {
      await checkAndRequestPermissions({ reason: 'permission_added' });
    }

    if (affectsTelemetryConsent(permissions)) {
      await telemetryClient.setConsent(true);
    }
    })
  );
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
      lastResult: snapshot.state.lastDnrSync || null,
      health: snapshot.state.dnrSyncHealth || null
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
      tracker: { ...dailyLimitTracker.getDebugState(),
        lastVisibleSample: await dailyLimitTracker.getLastVisibleSample() }
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

browser.runtime.onInstalled.addListener(details =>
  runInstalledEvent(details?.reason, async step => {
    logger.log(`Extension event: ${details.reason}`);

    try {
      await browser.runtime.setUninstallURL("https://blockdistraction.com/uninstall.html");
    } catch (error) {
      logger.info('Uninstall URL could not be set:', error);
    }

    await ensureAlarmsCreated();
    try {
      await telemetryClient.restoreRetry();
    } catch (error) {
      logger.info('Could not restore the telemetry retry after an extension event:', error);
    }

    if (details.reason === 'install') {
      logger.log("This is a fresh install. Checking permissions...");
      await step('initialize', () => initializeExtension(details));
      await step('permissions', () =>
        checkAndRequestPermissions(details, { notifyIfMissing: true })
      );
      await openInstallPage({
        runtimeApi: browser.runtime,
        tabsApi: browser.tabs,
        step,
        onFallback: error => diagnosticStore.recordEvent('warn', 'worker', 'install_options_fallback', {
          errorName: error instanceof TypeError ? 'TypeError' : 'Error'
        })
      });
    } else if (details.reason === 'update') {
      logger.log("This is an update. Checking permissions...");
      await step('initialize', () => initializeExtension(details));
      await step('permissions', () =>
        checkAndRequestPermissions(details, { notifyIfMissing: true })
      );
    } else if (details.reason === 'chrome_update' || details.reason === 'browser_update') {
      logger.log("Browser updated.");
      await step('initialize', () => initializeExtension(details));
      await step('dnr_integrity', () => dnrSynchronizer.validateIntegrity());
      await step('permissions', () =>
        checkAndRequestPermissions(details, { notifyIfMissing: true })
      );
    } else if (details.reason === 'shared_module_update') {
      logger.log("Shared module updated.");
    }
  })
);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'rules:health') {
    let allowed = false;
    try {
      const actual = new URL(sender?.url);
      const expected = new URL(browser.runtime.getURL('options/options.html'));
      allowed = Boolean(browser.runtime.id) && sender?.id === browser.runtime.id &&
        actual.protocol === expected.protocol && actual.host === expected.host &&
        actual.pathname === expected.pathname;
    } catch { /* A missing or non-Options sender is not a view health check. */ }
    sendResponse(allowed ? { success: true, protocol: 1 }
      : { success: false, code: 'rules_health_forbidden' });
    return false;
  }

  if (message?.type === DAILY_LIMIT_VISIBILITY_MESSAGE) {
    if (!isDailyLimitVisibilitySender(message, sender, browser.runtime)) {
      sendResponse({ success: false, code: 'daily_limit_visibility_forbidden' });
      return false;
    }
    dailyLimitTracker.visibilityChanged({ tabId: sender.tab.id, url: sender.url,
      visibilityState: message.visibilityState, observedAt: message.observedAt })
      .then(() => sendResponse({ success: true }), error => {
        logger.info('Daily limit page visibility sample failed:', error);
        sendResponse({ success: false, code: 'daily_limit_visibility_failed' });
      });
    return true;
  }

  // Leave addressed playback messages to the offscreen document's listener.
  if (message?.target === 'sound-offscreen') return false;
  if (message?.type === 'sound:preview') {
    if (!isSoundPreviewSender(sender, browser.runtime)) {
      sendResponse({ success: false, code: 'sound_preview_forbidden' });
      return false;
    }
    focusSound.preview().then(sendResponse,
      () => sendResponse({ success: false, code: 'audio_unavailable' }));
    return true;
  }

  if (['pro_guidance:preview', 'pro_guidance:shown', 'pro_guidance:dismiss'].includes(message.type)) {
    const operation = message.type.slice('pro_guidance:'.length);
    proGuidanceController[operation](message).then(
      result => sendResponse({ success: true, ...result }),
      () => sendResponse({ success: false, error: { code: 'pro_guidance_failed' } })
    );
    return true;
  }

  if (RULES_INTENT_TYPES.has(message.type)) {
    (async () => {
      try {
        const result = await enqueueRulesTransition(async () => {
          const recovered = await recoverPendingDailyUsage('rules_intent');
          const committed = await handleRulesIntent(message);
          return recovered ? committed : {
            ...committed,
            dailyUsageSyncPending: true
          };
        });
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
        if (error?.code === 'rule_limit_reached') {
          telemetryTasks.push(telemetryStore.incrementCounter('free_rule_limit_reached'));
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
      try {
        await telemetryStore.recordError(message.payload || {});
        sendResponse({ success: true });
      } catch (error) {
        logger.info('Telemetry error report could not be persisted:', error);
        sendResponse({
          success: false,
          error: { code: 'telemetry_record_failed' }
        });
      }
    })();
    return true;
  }

  if (message.type === 'telemetry:flush') {
    (async () => {
      try {
        const result = await telemetryClient.flush({ force: message.force === true });
        sendResponse({ success: true, result });
      } catch (error) {
        logger.info('Telemetry flush could not be completed:', error);
        sendResponse({
          success: false,
          error: { code: 'telemetry_flush_failed' }
        });
      }
    })();
    return true;
  }

  if (message.type === 'close_current_tab') {
    const tabId = sender.tab?.id;
    const reply = success => {
      // A successful close normally destroys the page receiving the reply.
      try { sendResponse({ success }); } catch { /* Receiver already closed. */ }
    };
    if (!Number.isInteger(tabId) || tabId < 0) {
      reply(false);
      return;
    }
    void runAsyncHandler(ASYNC_HANDLER_OPERATIONS.CLOSE_CURRENT_TAB, async () => {
      try { await browser.tabs.remove(tabId); }
      catch (error) { reply(false); throw error; }
      reply(true);
    });
    return true;
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
    void runAsyncHandler(
      ASYNC_HANDLER_OPERATIONS.RECORD_BLOCK,
      () => StatisticsManager.recordBlock(message.url)
    );
    return;
  }
  
  if (message.type === 'record_redirect') {
    const generation = blockingDecisionGeneration;
    const isCurrent = () => generation === blockingDecisionGeneration;
    const reply = response => { try { return sendResponse(response) !== false; } catch { return false; } };
    void (async () => {
      try {
        const verified = await authorizeRedirect({ sender, runtimeApi: browser.runtime,
          dnrApi: browser.declarativeNetRequest, isCurrent });
        if (!verified || !isCurrent()) { reply({ success: false }); return; }
        const decision = await redirectNavigationGuard.authorize(sender, verified, {
          documentToken: message.documentToken, isCurrent
        });
        if (!isCurrent() || !decision.allowed) {
          const delivered = reply({ success: false, ...(decision.obsolete ? { obsolete: true } : {}) });
          if (delivered && isCurrent() && decision.recordBlock) void runAsyncHandler(ASYNC_HANDLER_OPERATIONS.RECORD_BLOCK,
            () => StatisticsManager.recordBlock(verified.from));
          return;
        }
        if (!reply({ success: true, to: verified.to })) return;
        // The same document's repeated message cannot inflate statistics.
        // Statistics must not hold the redirect response open.
        if (decision.recordRedirect) void runAsyncHandler(ASYNC_HANDLER_OPERATIONS.RECORD_REDIRECT,
          () => StatisticsManager.recordRedirect(verified.from, verified.to));
      } catch { reply({ success: false }); }
    })();
    return true;
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
          expiryDate: null
        }, null, { manual: true });
        sendResponse({ success: true, isPro: false });
      } catch (error) {
        sendResponse({ success: false, error: error.message, ...(error.code ? { code: error.code } : {}) });
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
    void runAsyncHandler(ASYNC_HANDLER_OPERATIONS.DNR_RELOAD_MESSAGE, async () => {
      await dnrSynchronizer.requestSync({ trigger: 'rules_change' });
      logger.log('Legacy rules reload completed.');
    });
    return;
  }
  
  if (message.type === 'pro_status_changed') {
    void runAsyncHandler(ASYNC_HANDLER_OPERATIONS.PRO_STATUS_TRANSITION, () =>
      enqueueProStatusTransition(async () => {
        await updateContextMenu(await ProManager.hasPaidAccess());
      })
    );
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
  
  if (['focus_schedule_get', 'focus_schedule_save', 'focus_schedule_skip', 'focus_schedule_restore'].includes(message.type)) {
    const operation = message.type === 'focus_schedule_save'
      ? () => focusScheduleController.save(message.config, message.revision)
      : message.type === 'focus_schedule_skip'
        ? () => focusScheduleController.skip(message.key, message.revision, message.startTime)
        : message.type === 'focus_schedule_restore'
          ? () => focusScheduleController.restore(message.key, message.revision, message.startTime)
          : () => focusScheduleController.status();
    void operation().then(
      state => sendResponse({ success: true, ...state }),
      error => sendResponse({ success: false, code: error.code || 'focus_schedule_failed' })
    );
    return true;
  }

  if (message.type === 'pomodoro_status') {
    (async () => {
      const focus = await reconcileFocusSession('popup');
      const cycle = await reconcilePomodoro('popup');
      sendResponse({ success: focus?.status !== 'failed' && cycle?.status !== 'failed' });
    })().catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'start_pomodoro' || message.type === 'continue_pomodoro') {
    invalidateBlockingDecisions();
    const generation = ++focusSessionTransitionGeneration;
    (async () => {
      try {
        const result = await enqueueFocusSessionTransition(async () => {
          if (generation !== focusSessionTransitionGeneration) return false;
          const stored = await browser.storage.local.get([POMODORO_KEY, 'focusSession']);
          const cycle = await readCurrentPomodoro();
          const focus = stored.focusSession;
          if (message.type === 'start_pomodoro' && isPomodoroHardcoreLocked(cycle)) {
            if (focus?.focusActive) await preserveActiveFocus(focus, generation);
            else await armPomodoro(cycle);
            return { success: false, code: 'hardcore_active' };
          }
          if (focus?.focusActive && focus.focusEndTime > Date.now()) {
            await preserveActiveFocus(focus, generation);
            return { success: false, code: focus.isHardcore ? 'hardcore_active' : 'focus_active' };
          }
          if (generation !== focusSessionTransitionGeneration) return false;
          if (message.type === 'continue_pomodoro') {
            if (!cycle || cycle.phase === 'work' || cycle.id !== message.id || cycle.completedRounds !== message.completedRounds) return { success: false, code: 'pomodoro_changed' };
            await focusScheduleController.suppressCurrent();
            return continuePomodoroStored(cycle, generation);
          }
          if (cycle) return { success: false, code: 'pomodoro_changed' };
          const config = normalizePomodoroConfig(message.config, await getFocusAccess());
          if (generation !== focusSessionTransitionGeneration) return false;
          await focusScheduleController.suppressCurrent();
          const next = startPomodoro(config, Date.now(), crypto.randomUUID());
          return activateFocusSession({ durationMinutes: config.workMinutes,
            isHardcore: config.isHardcore, focusMode: config.focusMode }, generation, null, null, next);
        });
        sendResponse(typeof result === 'object' ? result : { success: true, ...(!result ? { superseded: true } : {}) });
      } catch (error) {
        if (['pro_required', 'invalid_pomodoro'].includes(error.code)) logger.info('Pomodoro action rejected:', error.code);
        else logger.error('Pomodoro action failed:', error);
        sendResponse({ success: false, code: error.code || 'pomodoro_failed' });
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

    invalidateBlockingDecisions();
    const transitionGeneration = ++focusSessionTransitionGeneration;
    (async () => {
      try {
        const completed = await enqueueFocusSessionTransition(async () => {
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;
          const stored = await browser.storage.local.get([POMODORO_KEY, 'focusSession']);
          if (stored.focusSession?.focusActive && stored.focusSession.isHardcore && stored.focusSession.focusEndTime > Date.now()) {
            await preserveActiveFocus(stored.focusSession, transitionGeneration);
            return { success: false, code: 'hardcore_active' };
          }
          const cycle = await readCurrentPomodoro();
          if (isPomodoroHardcoreLocked(cycle)) { await armPomodoro(cycle); return { success: false, code: 'hardcore_active' }; }
          if (cycle) return { success: false, code: 'pomodoro_changed' };
          await focusScheduleController.suppressCurrent();
          return activateFocusSession(request, transitionGeneration);
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
  
  if (message.type === 'stop_focus_session' || message.type === 'stop_pomodoro') {
    invalidateBlockingDecisions();
    const transitionGeneration = ++focusSessionTransitionGeneration;
    (async () => {
      try {
        const completed = await enqueueFocusSessionTransition(async () => {
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          const before = await browser.storage.local.get([POMODORO_KEY, 'focusSession']);
          const cycle = await readCurrentPomodoro();
          if (isPomodoroHardcoreLocked(cycle)) {
            if (before.focusSession?.focusActive) await preserveActiveFocus(before.focusSession, transitionGeneration);
            else await armPomodoro(cycle);
            return { success: false, code: 'hardcore_active' };
          }
          if (message.type === 'stop_pomodoro' && message.phase !== undefined &&
              (cycle?.phase !== message.phase || cycle?.completedRounds !== message.completedRounds)) {
            return { success: false, code: 'pomodoro_changed' };
          }
          if (message.type === 'stop_pomodoro' && (!cycle || cycle.id !== message.id)) return { success: false, code: 'pomodoro_changed' };
          if (before.focusSession?.focusActive && before.focusSession.isHardcore && before.focusSession.focusEndTime > Date.now()) {
            const access = await getFocusAccess();
            if (access.isPro || access.isLegacyUser) {
              await preserveActiveFocus(before.focusSession, transitionGeneration);
              return { success: false, code: 'hardcore_active' };
            }
          }
          await focusScheduleController.suppressCurrent();
          await dailyLimitTracker.sample('focus_stop_before');
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          const { focusSession: previousFocusSession } = await browser.storage.local.get(['focusSession']);
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;

          await browser.storage.local.set({ focusSession: { ...INACTIVE_FOCUS_SESSION }, [POMODORO_KEY]: null });
          await browser.alarms.clear(POMODORO_LOCK_ALARM);
          let syncResult;
          try {
            // Finish a committed Stop before the next queued Start can write its state.
            await dailyLimitTracker.sample('focus_stop_after');
            await browser.alarms.clear('end_focus_session');
            await browser.alarms.clear(POMODORO_ALARM);
            syncResult = await dnrSynchronizer.requestSync({ trigger: 'focus_stop' });
          } finally {
            // Count the stored active -> inactive transition, including a pending DNR sync.
            // Repeated Stop still performs cleanup without recording another stopped session.
            if (previousFocusSession?.focusActive === true) {
              logger.log('Focus Session: Stopped by user.');
              const outcomes = await Promise.allSettled([
                diagnosticStore.recordEvent('info', 'focus', 'session_stopped', { reason: 'user' }),
                telemetryStore.incrementCounter('focus_stopped')
              ]);
              for (const outcome of outcomes) {
                if (outcome.status === 'rejected') {
                  logger.info('Focus stop reporting could not be persisted:', outcome.reason);
                }
              }
            }
          }
          if (transitionGeneration !== focusSessionTransitionGeneration) return false;
          return { success: true, ...(syncResult?.success === false ? { syncPending: true } : {}) };
        });
        if (completed && typeof completed === 'object') {
          sendResponse(completed);
          return;
        }
        sendResponse({ success: true, ...(completed ? {} : { superseded: true }) });
      } catch (error) {
        logger.error('Focus Session: Error stopping session:', error);
        const outcomes = await Promise.allSettled([
          diagnosticStore.recordEvent('error', 'focus', 'stop_failed', { error }),
          telemetryStore.recordError({
            source: 'focus', code: 'stop_failed', operation: 'stop_session', errorName: error?.name || 'Error'
          })
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            logger.info('Focus stop failure reporting could not be persisted:', outcome.reason);
          }
        }
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  
  if (message.type === 'permissions_granted') {
    logger.log("Permissions granted via onboarding.");
    void runAsyncHandler(
      ASYNC_HANDLER_OPERATIONS.DNR_RELOAD_MESSAGE,
      () => dnrSynchronizer.requestSync({ trigger: 'permissions' })
    );
  }
  
  if (message.type === 'delete_all_rules') {
    (async () => {
      try {
        const result = await enqueueRulesTransition(() => rulesMutationService.clearRules());
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

installWorkerErrorReporting({
  runtime: browser.runtime,
  recordError: error => telemetryStore.recordError(error),
  logger
});

async function runDailyMaintenanceStep(name, operation) {
  try {
    return await operation();
  } catch (error) {
    logger.error(`Daily license maintenance: ${name} failed:`, error);
    return null;
  }
}

browser.alarms.onAlarm.addListener(alarm =>
  runAsyncHandler(ASYNC_HANDLER_OPERATIONS.SCHEDULED_ALARM, async () => {
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
  
  if (alarm.name === FOCUS_SCHEDULE_ALARM) {
    await reconcileFocusSession('scheduled_focus_alarm');
    await reconcileScheduledFocus('scheduled_focus_alarm');
  }

  if (alarm.name === POMODORO_LOCK_ALARM) {
    await reconcilePomodoro('hardcore_deadline');
    return;
  }
  if (alarm.name === POMODORO_ALARM) {
    await reconcilePomodoro('alarm', alarm.scheduledTime);
    return;
  }
  if (alarm.name === 'end_focus_session') {
    await reconcileFocusSession('alarm', {
      expectedEndTime: alarm.scheduledTime,
      allowEarlyCompletion: true
    });
  }
  
  if (alarm.name === DAILY_LIMIT_DEADLINE_ALARM) {
    await runAsyncHandler(
      ASYNC_HANDLER_OPERATIONS.DAILY_LIMIT_ALARM,
      () => dailyLimitTracker.sample('deadline_alarm')
    );
  }

  if (alarm.name === 'update_scheduled_rules') {
    await reconcileFocusSession('minute_alarm');
    await reconcileScheduledFocus('minute_alarm');
    await runAsyncHandler(ASYNC_HANDLER_OPERATIONS.DAILY_LIMIT_ALARM, async () => {
      if (await recoverPendingDailyUsage('minute_alarm')) {
        await dailyLimitTracker.sample('minute_alarm');
      }
    });
    await Promise.all([
      dnrSynchronizer.requestSync({ reconcileExistingTabs: false, trigger: 'minute_alarm' }),
      checkAndRequestPermissions({ reason: 'scheduled_alarm' })
    ]);
  }
  })
);

let alarmSetupPromise = null;

function ensureAlarmsCreated() {
  if (alarmSetupPromise) return alarmSetupPromise;
  // One failed alarm must not stop the other one. Share a pending setup across
  // cold import, startup and install so existing deadlines are not reset twice.
  const alarms = [
    ['check_pro_expiry', { delayInMinutes: 0.5, periodInMinutes: 1440 }],
    ['update_scheduled_rules', { periodInMinutes: 1 }]
  ];
  alarmSetupPromise = Promise.all(alarms.map(([name, details]) =>
    runAsyncHandler(ASYNC_HANDLER_OPERATIONS.STARTUP, async () => {
      if (!await getAlarm(name)) await browser.alarms.create(name, details);
    })
  )).finally(() => { alarmSetupPromise = null; });
  return alarmSetupPromise;
}

void ensureAlarmsCreated();

void reconcileScheduledFocus();
