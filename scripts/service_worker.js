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
import { createRulesMigrationService } from '../rules/rulesMigrationService.js';
import { createRulesMutationService, serializeRulesMutationError } from '../rules/rulesMutationService.js';
import { RULES_INTENT_TYPES, createRulesIntentHandler } from '../rules/rulesIntentRouter.js';
import { resolveRulePackEntries } from '../rules/rulePacks.js';
import { createDiagnosticStore } from '../diagnostics/diagnosticStore.js';
import { buildDiagnosticReport, detectBrowserSummary } from '../diagnostics/diagnosticReport.js';

const logger = new Logger('Worker');
const rulesManager = new RulesManager();
const diagnosticStore = createDiagnosticStore({
  localStorage: browser.storage.local,
  getSettings: () => SettingsManager.getSettings()
});

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
    await diagnosticStore.recordEvent('error', 'dnr', 'sync_failed', {
      removed: result.removed,
      added: result.added,
      error: result.error || 'Unknown DNR synchronization error'
    });
  }
}
const createDnrRule = createDnrRuleFactory(
  path => browser.runtime.getURL(path)
);

const dnrSynchronizer = createDnrSynchronizer({
  getRules: () => rulesManager.getRules(),
  getSettings: () => SettingsManager.getSettings(),
  getFocusSessionState,
  isRuleActiveNow,
  createDnrRule,
  closeTabsMatchingRules,
  declarativeNetRequest: browser.declarativeNetRequest,
  logger,
  onSyncResult: recordDnrSyncResult
});

const rulesMigrationService = createRulesMigrationService({
  rulesManager,
  localStorage: browser.storage.local,
  syncStorage: browser.storage.sync,
  logger
});

function notifyRulesChanged(rules, extra = {}) {
  try {
    browser.runtime.sendMessage({
      type: 'rules:changed',
      rules,
      ...extra
    }, () => {
      void browser.runtime.lastError;
    });
  } catch (error) {
    logger.info('No active extension page received rules:changed:', error);
  }
}

const rulesMutationService = createRulesMutationService({
  rulesManager,
  dnrSynchronizer,
  declarativeNetRequest: browser.declarativeNetRequest,
  getAccess: async () => ({
    isPro: await ProManager.isPro(),
    isLegacyUser: await ProManager.isLegacyUser()
  }),
  getSettings: () => SettingsManager.getSettings(),
  saveSettings: (settings) => browser.storage.sync.set({ settings }),
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
  }
  
  if (changeInfo.status === 'complete' && tab.url) {
    await trackBlockedPage(tab.url);
  }
});

browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.id && tab.url) {
    await enforceFocusWhitelist(tab.id, tab.url);
  }
  
  if (tab.url && tab.url !== 'about:blank' && tab.url !== 'chrome://newtab/') {
    await trackBlockedPage(tab.url);
  }
});

browser.runtime.onStartup.addListener(async () => {
  const skip = await shouldSkipSync();
  if (skip) return;
  
  ensureAlarmsCreated();
  
  await initializeExtension({ reason: 'startup' });
  await checkAndRequestPermissions({ reason: 'startup' });
  
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

  if (migrationResult.migrated) {
    await dnrSynchronizer.requestSync();
    notifyRulesChanged(migrationResult.rules, {
      migrated: true
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

let isCheckingPermissions = false;

async function checkAndRequestPermissions(details) {
  if (isCheckingPermissions) return;
  isCheckingPermissions = true;
  
  try {
    let granted;
    if (typeof browser.permissions?.contains === 'function') {
      granted = await browser.permissions.contains({
        origins: ["*://*/*"]
      });
    } else {
      logger.warn("Permissions API not available. Assuming granted.");
      granted = true;
    }
    
    await diagnosticStore.updateState({
      lastPermissionCheck: {
        timestamp: Date.now(),
        hostAccess: granted,
        reason: details?.reason || 'unknown'
      }
    });

    if (!granted) {
      await diagnosticStore.recordEvent('warn', 'permissions', 'host_access_missing', {
        reason: details?.reason || 'unknown'
      });
      logger.log("Host permission NOT granted. Opening onboarding page.");
      const onboardingUrl = browser.runtime.getURL('onboarding/onboarding.html');
      const tabs = await browser.tabs.query({ url: onboardingUrl });
      
      if (tabs.length === 0) {
        browser.tabs.create({ url: onboardingUrl });
      }
    }
    
    return granted;
  } catch (err) {
    logger.error("Error checking permissions:", err);
    await diagnosticStore.updateState({
      lastPermissionCheck: {
        timestamp: Date.now(),
        hostAccess: false,
        reason: details?.reason || 'unknown',
        error: err?.message || String(err)
      }
    });
    await diagnosticStore.recordEvent('error', 'permissions', 'check_failed', {
      reason: details?.reason || 'unknown',
      error: err
    });
    return false;
  } finally {
    isCheckingPermissions = false;
  }
}

if (browser.permissions && browser.permissions.onRemoved) {
  browser.permissions.onRemoved.addListener(async (permissions) => {
    if (permissions.origins && permissions.origins.includes("*://*/*")) {
      logger.warn("Host permission revoked by user or browser. Opening onboarding.");
      
      const tabs = await browser.tabs.query({ url: browser.runtime.getURL('onboarding/onboarding.html') });
      if (tabs.length === 0) {
        browser.tabs.create({
          url: browser.runtime.getURL('onboarding/onboarding.html')
        });
      }
    }
  });
}

async function ensureDiagnosticsAccess() {
  const [isPro, isLegacyUser] = await Promise.all([
    ProManager.isPro(),
    ProManager.isLegacyUser()
  ]);

  if (!isPro && !isLegacyUser) {
    const error = new Error('Pro mode is required for diagnostics');
    error.code = 'pro_required';
    throw error;
  }

  return { isPro, isLegacyUser };
}

async function createDiagnosticReport() {
  const access = await ensureDiagnosticsAccess();
  const [settings, rules, credentials, focusSession] = await Promise.all([
    SettingsManager.getSettings(),
    rulesManager.getRules(),
    ProManager.getCredentials(),
    getFocusSessionState()
  ]);

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

  const snapshot = await diagnosticStore.getSnapshot();

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
      alarms: Boolean(browser.alarms)
    },
    access,
    settings: {
      debugMode: settings.debugMode === true,
      mode: settings.mode || 'normal',
      disabledCategories: Array.isArray(settings.disabledCategories) ?
        settings.disabledCategories : []
    },
    rules: {
      total: rules.length,
      blacklist: rules.filter(rule => !rule.isWhitelist).length,
      whitelist: rules.filter(rule => rule.isWhitelist).length,
      scheduled: rules.filter(rule => rule.schedule).length,
      disabledByUser: rules.filter(rule => rule.disabledByUser).length
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
    license: {
      isPro: credentials.isPro === true,
      expiryDate: credentials.expiryDate || null,
      lastCheck: snapshot.state.lastLicenseCheck || null
    },
    recentEvents: snapshot.events
  });
}

browser.runtime.onInstalled.addListener(async (details) => {
  logger.log(`Extension event: ${details.reason}`);
  
  browser.runtime.setUninstallURL("https://blockdistraction.com/uninstall.html");
  
  ensureAlarmsCreated();
  
  if (details.reason === 'install') {
    logger.log("This is a fresh install. Checking permissions...");
    await initializeExtension(details);
    await checkAndRequestPermissions(details);
    
    const installUrl = createInstallURL();
    browser.tabs.create({
      url: installUrl,
      active: true
    });
  } else if (details.reason === 'update') {
    logger.log("This is an update. Checking permissions...");
    await initializeExtension(details);
    await checkAndRequestPermissions(details);
  } else if (details.reason === 'chrome_update' || details.reason === 'browser_update') {
    logger.log("Browser updated.");
    await initializeExtension(details);
    await dnrSynchronizer.validateIntegrity();
    await checkAndRequestPermissions(details);
  } else if (details.reason === 'shared_module_update') {
    logger.log("Shared module updated.");
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (RULES_INTENT_TYPES.has(message.type)) {
    (async () => {
      try {
        const result = await handleRulesIntent(message);
        sendResponse({ success: true, ...result });
      } catch (error) {
        logger.error(`Rules intent failed (${message.type}):`, error);
        await diagnosticStore.recordEvent('error', 'rules', 'intent_failed', {
          intent: message.type,
          errorCode: error?.code || 'unknown',
          validationErrors: error?.validationErrors || []
        });
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
        await ensureDiagnosticsAccess();
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
        
        await browser.storage.local.set({
          focusSession: { focusActive: true, focusEndTime: endTime, isHardcore, focusMode }
        });
        
        browser.alarms.create('end_focus_session', { delayInMinutes: durationMinutes });
        
        await dnrSynchronizer.requestSync();
        
        if (focusMode === 'whitelist') {
          await checkAllTabsAgainstWhitelist();
        }
        
        logger.log(`Focus Session: Started for ${durationMinutes} minutes (mode: ${focusMode}).`);
        await diagnosticStore.recordEvent('info', 'focus', 'session_started', {
          durationMinutes,
          focusMode,
          isHardcore
        });
        sendResponse({ success: true });
      } catch (error) {
        logger.error('Focus Session: Error starting session:', error);
        await diagnosticStore.recordEvent('error', 'focus', 'start_failed', { error });
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  
  if (message.type === 'stop_focus_session') {
    (async () => {
      try {
        await browser.storage.local.set({
          focusSession: { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' }
        });
        await browser.alarms.clear('end_focus_session');
        await dnrSynchronizer.requestSync();
        logger.log('Focus Session: Stopped by user.');
        await diagnosticStore.recordEvent('info', 'focus', 'session_stopped', {
          reason: 'user'
        });
        sendResponse({ success: true });
      } catch (error) {
        logger.error('Focus Session: Error stopping session:', error);
        await diagnosticStore.recordEvent('error', 'focus', 'stop_failed', { error });
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

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check_pro_expiry') {
    await updateUninstallURL();
    const syncResult = await syncLicenseKeyStatus();
    await updateContextMenu(syncResult.isPro);
  }
  
  if (alarm.name === 'end_focus_session') {
    logger.log('Focus Session: Alarm triggered, ending session.');
    await browser.storage.local.set({
      focusSession: { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' }
    });
    await dnrSynchronizer.requestSync();
    await StatisticsManager.recordFocusSession();
    await diagnosticStore.recordEvent('info', 'focus', 'session_completed', {
      reason: 'alarm'
    });
    
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
    await dnrSynchronizer.requestSync();
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