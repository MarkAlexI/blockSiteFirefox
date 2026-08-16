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
import { getAssignmentUsageKey, getRuleAssignments } from '../rules/ruleAssignments.js';
import { createRulesMigrationService } from '../rules/rulesMigrationService.js';
import { RuleListsManager } from '../rules/ruleListsManager.js';
import { DailyLimitManager } from '../rules/dailyLimitManager.js';
import { createDailyLimitTracker } from '../rules/dailyLimitTracker.js';
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
import { shouldRecordLicenseReliabilityError } from '../telemetry/telemetryLicenseError.js';

const logger = new Logger('Worker');
const rulesManager = new RulesManager();
const ruleListsManager = new RuleListsManager(browser.storage.local);
const dailyLimitManager = new DailyLimitManager(browser.storage.local);


function getDailyLimitAssignmentKeys(rules = []) {
  return (rules || []).flatMap(rule =>
    getRuleAssignments(rule)
      .filter(assignment => assignment.blockingMode === BLOCKING_MODE_DAILY_LIMIT)
      .map(assignment => getAssignmentUsageKey(rule.id, assignment.listId))
      .filter(Boolean)
  );
}
const diagnosticStore = createDiagnosticStore({
  localStorage: browser.storage.local,
  getSettings: async () => {
    const [settings, isPro, isLegacyUser] = await Promise.all([
      SettingsManager.getSettings(),
      ProManager.isPro(),
      ProManager.isLegacyUser()
    ]);
    return {
      ...settings,
      debugMode: settings.debugMode === true && (isPro || isLegacyUser)
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
  const [credentials, isPro, isLegacyUser] = await Promise.all([
    ProManager.getCredentials(),
    ProManager.isPro(),
    ProManager.isLegacyUser()
  ]);
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

async function recordDnrSyncResult(result) {
  if (result.changed || !result.success) {
    await diagnosticStore.updateState({
      lastDnrSync: {
        timestamp: Date.now(),
        success: result.success,
        changed: result.changed,
        removed: result.removed,
        added: result.added,
        error: result.error || null
      }
    });
  }

  if (!result.success) {
    await Promise.all([
      diagnosticStore.recordEvent('error', 'dnr', 'sync_failed', {
        removed: result.removed,
        added: result.added,
        error: result.error || 'Unknown DNR synchronization error'
      }),
      telemetryStore.recordError({
        source: 'dnr',
        code: 'sync_failed',
        operation: 'update_dynamic_rules',
        errorName: 'Error'
      })
    ]);
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
  declarativeNetRequest: browser.declarativeNetRequest,
  getAccess: async () => ({
    isPro: await ProManager.isPro(),
    isLegacyUser: await ProManager.isLegacyUser()
  }),
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
  
  const { focusActive, focusMode } = await getFocusSessionState();
  if (!focusActive || focusMode !== 'whitelist') {
    return;
  }
  
  const rules = await rulesManager.getRules();
  const whitelistRules = rules.filter(r => r.isWhitelist && !r.disabledByUser);
  
  if (!isUrlInWhitelist(tabUrl, whitelistRules)) {
    logger.log(`Focus Whitelist: Closing non-whitelisted tab ${tabId} (${tabUrl})`);
    browser.tabs.remove(tabId).catch(() => {});
  }
}

/**
 * Scans all currently open tabs and closes any tab that does not match active Whitelist rules.
 */
async function checkAllTabsAgainstWhitelist() {
  const rules = await rulesManager.getRules();
  const whitelistRules = rules.filter(r => r.isWhitelist && !r.disabledByUser);
  
  await closeNonWhitelistedTabs(whitelistRules);
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

async function syncLicenseKeyStatus() {
  const credentials = await ProManager.getCredentials();
  const currentKey = credentials.licenseKey;
  
  if (!currentKey) {
    logger.log('License Sync: No key stored, skipping sync.');
    if (credentials.isPro) {
      await handleProStatusUpdate(false, { licenseKey: null, expiryDate: null, subscriptionEmail: null });
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
      const isTemporaryFailure = response.status === 429 || response.status >= 500;
      
      if (isTemporaryFailure) {
        throw new Error(errorMessage);
      }
      
      await handleProStatusUpdate(false, {
        licenseKey: null,
        expiryDate: null,
        subscriptionEmail: null
      });
      logger.warn(`License Sync: Server rejected the stored key (${response.status}).`);
      return finishLicenseCheck({ success: true, isPro: false, reason: 'rejected', error: errorMessage });
    }
    
    if (typeof data.isPro !== 'boolean') {
      throw new Error('License server returned an invalid response');
    }
    
    await handleProStatusUpdate(data.isPro, {
      licenseKey: currentKey,
      subscriptionEmail: data.email,
      expiryDate: data.expiryDate
    });
    
    logger.log('License Sync: Status updated from server. isPro:', data.isPro);
    return finishLicenseCheck({ success: true, isPro: data.isPro, reason: 'verified' });
    
  } catch (error) {
    const errorMessage = error.name === 'AbortError' ?
      'License verification timed out' :
      error.message;
    logger.error('License Sync: Error:', errorMessage);
    return finishLicenseCheck({ success: false, isPro: credentials.isPro, reason: 'temporary_failure', error: errorMessage });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function updateContextMenu(isPro) {
  if (!browser.contextMenus) return;
  
  browser.contextMenus.remove('blockDistraction', () => {
    void browser.runtime.lastError;
    
    if (isPro) {
      const menuTitle = browser.i18n.getMessage('blockthat');
      
      browser.contextMenus.create({
        id: 'blockDistraction',
        title: menuTitle,
        contexts: IS_FIREFOX ? ['link'] : ['page', 'link']
      }, () => {
        void browser.runtime.lastError;
        logger.log('BlockDistraction context menu created');
      });
    } else {
      logger.log('BlockDistraction context menu removed (non-pro mode)');
    }
  });
}

if (browser.contextMenus) {
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'blockDistraction') return;
    
    const isPro = await ProManager.isPro();
    if (!isPro) {
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

async function handleProStatusUpdate(isPro, subscriptionData = {}) {
  try {
    logger.log(`Service worker received Pro status update: ${isPro}`);
    const updatedCredentials = await ProManager.setProStatusFromWorker(isPro, subscriptionData);
    logger.log('Pro status updated successfully');
    await updateContextMenu(isPro);
    return updatedCredentials;
  } catch (error) {
    logger.error('Error handling Pro status update:', error);
    throw error;
  }
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    await enforceFocusWhitelist(tabId, changeInfo.url);
    if (tab.active) await dailyLimitTracker.sample('tab_url_changed', new Date(), tab);
  }
  
  if (changeInfo.status === 'complete' && tab.url) {
    await trackBlockedPage(tab.url);
  }
});

browser.tabs.onActivated.addListener((activeInfo) => {
  void browser.tabs.get(activeInfo.tabId)
    .then(tab => dailyLimitTracker.sample('tab_activated', new Date(), tab))
    .catch(error => logger.info('Daily limit tab activation sample failed:', error));
});

browser.windows.onFocusChanged.addListener(() => {
  void dailyLimitTracker.sample('window_focus_changed');
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
  await telemetryClient.restoreRetry();

  const skip = await shouldSkipSync();
  if (skip) return;
  
  ensureAlarmsCreated();
  
  await initializeExtension({ reason: 'startup' });
  await checkAndRequestPermissions({ reason: 'startup' }, { notifyIfMissing: true });
  
  await dailyLimitTracker.sample('startup');
  logger.log("Extension startup - syncing DNR rules");
  await dnrSynchronizer.requestSync();
  
  try {
    const result = await syncLicenseKeyStatus();
    logger.log('Startup: Pro status is', result.isPro, '- updating context menu...');
    await updateContextMenu(result.isPro);
    await browser.storage.local.set({ lastCheck: Date.now() });
  } catch (error) {
    logger.error('Error syncing:', error);
  }
  
  await dnrSynchronizer.validateIntegrity();
});

async function initializeExtension(details) {
  logger.log("Initializing extension state (rules, settings, legacy status)...");
  const migrationResult = await rulesMutationService.runExclusive(
    () => rulesMigrationService.migrateAll()
  );

  await dailyLimitManager.pruneAssignmentKeys(
    getDailyLimitAssignmentKeys(migrationResult.rules || [])
  );

  if (migrationResult.migrated) {
    await dnrSynchronizer.requestSync();
    notifyRulesChanged(migrationResult.rules, {
      migrated: true,
      ruleLists: migrationResult.ruleLists,
      activeRuleListId: migrationResult.activeRuleListId
    });
  }
  await SettingsManager.getSettings();
  await StatisticsManager.getStatistics();
  await showUpdates(details);
  
  try {
    const credentials = await ProManager.getCredentials();
    
    if (details.reason === 'install') {
      const installDate = new Date().toISOString();
      const isLegacy = new Date() < new Date(ProManager.RESTRICTION_START_DATE);
      await ProManager.updateProStatus(credentials.isPro, {
        ...credentials,
        installationDate: installDate,
        isLegacyUser: isLegacy
      });
      logger.log(`New install: isLegacyUser set to ${isLegacy}`);
    } else if (details.reason === 'update') {
      if (credentials.installationDate === null || credentials.isLegacyUser === undefined) {
        await ProManager.updateProStatus(credentials.isPro, {
          ...credentials,
          installationDate: credentials.installationDate || new Date(0).toISOString(),
          isLegacyUser: true
        });
        logger.log('Migrated existing users to legacy status');
      }
    }
    
    const isPro = await ProManager.isPro();
    await updateContextMenu(isPro);
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
  const [isPro, isLegacyUser] = await Promise.all([
    ProManager.isPro(),
    ProManager.isLegacyUser()
  ]);
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
      disabledByUser: rules.filter(rule => rule.disabledByUser).length,
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
        const result = await handleRulesIntent(message);
        await dailyLimitManager.pruneAssignmentKeys(
          getDailyLimitAssignmentKeys(result.rules || [])
        );
        await Promise.all([
          recordRuleIntentTelemetry(message.type, result),
          dailyLimitTracker.sample('rules_intent')
        ]);
        sendResponse({ success: true, ...result });
      } catch (error) {
        logger.error(`Rules intent failed (${message.type}):`, error);
        const telemetryTasks = [
          diagnosticStore.recordEvent('error', 'rules', 'intent_failed', {
            intent: message.type,
            errorCode: error?.code || 'unknown',
            validationErrors: error?.validationErrors || []
          })
        ];

        if (shouldRecordRulesTelemetryError(error)) {
          telemetryTasks.push(telemetryStore.recordError({
            source: 'rules',
            code: getRulesTelemetryCode(error),
            operation: message.type.replace('rules:', ''),
            errorName: error?.name || 'Error'
          }));
        }

        await Promise.all(telemetryTasks);
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
  
  if (message.type === 'update_pro_status') {
    (async () => {
      try {
        const result = await handleProStatusUpdate(message.isPro, message.subscriptionData);
        sendResponse({ success: true, credentials: result });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
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
    (async () => {
      try {
        const credentials = await ProManager.getCredentials();
        sendResponse({ credentials });
      } catch (error) {
        sendResponse({ credentials: ProManager.defaultCredentials, error: error.message });
      }
    })();
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
    updateContextMenu(message.isPro);
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
    (async () => {
      try {
        const durationMinutes = message.duration || 25;
        const isHardcore = message.isHardcore || false;
        const focusMode = message.focusMode || 'blacklist';
        const endTime = Date.now() + durationMinutes * 60 * 1000;
        
        await dailyLimitTracker.sample('focus_start_before');
        await browser.storage.local.set({
          focusSession: { focusActive: true, focusEndTime: endTime, isHardcore, focusMode }
        });
        
        browser.alarms.create('end_focus_session', { delayInMinutes: durationMinutes });
        await dailyLimitTracker.sample('focus_start_after');
        
        await dnrSynchronizer.requestSync();
        
        if (focusMode === 'whitelist') {
          await checkAllTabsAgainstWhitelist();
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
        sendResponse({ success: true });
      } catch (error) {
        logger.error('Focus Session: Error starting session:', error);
        await Promise.all([
          diagnosticStore.recordEvent('error', 'focus', 'start_failed', { error }),
          telemetryStore.recordError({
            source: 'focus', code: 'start_failed', operation: 'start_session', errorName: error?.name || 'Error'
          })
        ]);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  
  if (message.type === 'stop_focus_session') {
    (async () => {
      try {
        await dailyLimitTracker.sample('focus_stop_before');
        await browser.storage.local.set({
          focusSession: { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' }
        });
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
        sendResponse({ success: true });
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

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check_pro_expiry') {
    await updateUninstallURL();
    const syncResult = await syncLicenseKeyStatus();
    await updateContextMenu(syncResult.isPro);
    await telemetryClient.flush();
  }

  if (alarm.name === TELEMETRY_RETRY_ALARM) {
    await telemetryClient.flush();
  }
  
  if (alarm.name === 'end_focus_session') {
    logger.log('Focus Session: Alarm triggered, ending session.');
    await dailyLimitTracker.sample('focus_complete_before');
    await browser.storage.local.set({
      focusSession: { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' }
    });
    await dailyLimitTracker.sample('focus_complete_after');
    await dnrSynchronizer.requestSync();
    await StatisticsManager.recordFocusSession();
    await Promise.all([
      diagnosticStore.recordEvent('info', 'focus', 'session_completed', {
        reason: 'alarm'
      }),
      telemetryStore.incrementCounter('focus_completed')
    ]);
    
    const settings = await SettingsManager.getSettings();
    const playSound = settings.focusSessionSound;
    
    if (browser.notifications) {
      browser.notifications.create('focus_session_ended', {
        type: 'basic',
        iconUrl: browser.runtime.getURL('images/icon-192.png'),
        title: browser.i18n.getMessage('focussessionheader'),
        message: browser.i18n.getMessage('focussessionended'),
        priority: 2,
        silent: !playSound
      });
    }
  }
  
  if (alarm.name === 'update_scheduled_rules') {
    await dailyLimitTracker.sample('minute_alarm');
    await Promise.all([
      dnrSynchronizer.requestSync(),
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