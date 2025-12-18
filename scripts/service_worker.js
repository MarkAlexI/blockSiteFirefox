import { RulesManager } from '../rules/rulesManager.js';
import { SettingsManager } from '../options/settings.js';
import { StatisticsManager } from '../pro/statisticsManager.js';
import { ProManager } from '../pro/proManager.js';
import { closeTabsMatchingRule } from './closeTabs.js';
import { normalizeUrlFilter } from './normalizeUrlFilter.js';
import Logger from '../utils/logger.js';
import { resolveContextTarget } from '../utils/resolveContextTarget.js';

const rulesManager = new RulesManager();
const VERIFY_API_URL = 'https://blockdistraction.com/api/verifyKey';

async function syncLicenseKeyStatus() {
  const credentials = await ProManager.getCredentials();
  const currentKey = credentials.licenseKey;
  
  if (!currentKey) {
    Logger.log('License Sync: No key stored, skipping sync.');
    if (credentials.isPro) {
      await handleProStatusUpdate(false, { licenseKey: null, expiryDate: null, subscriptionEmail: null });
    }
    return { success: false, isPro: false };
  }
  
  Logger.log('License Sync: Checking stored key...');
  try {
    const response = await fetch(VERIFY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: currentKey })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      await handleProStatusUpdate(false, {
        licenseKey: null,
        expiryDate: null,
        subscriptionEmail: null
      });
      throw new Error(data.error || 'Invalid key');
    }
    
    await handleProStatusUpdate(data.isPro, {
      licenseKey: currentKey,
      subscriptionEmail: data.email,
      expiryDate: data.expiryDate
    });
    
    Logger.log('License Sync: Status updated from server. isPro:', data.isPro);
    return { success: true, isPro: data.isPro };
    
  } catch (error) {
    Logger.error('License Sync: Error:', error.message);
    return { success: false, isPro: credentials.isPro };
  }
}

const IS_FIREFOX = typeof browser !== 'undefined';

async function updateContextMenu(isPro) {
  if (!browser.contextMenus) return;
  
  browser.contextMenus.remove('blockDistraction', () => {
    void browser.runtime.lastError;
    
    if (isPro) {
      browser.contextMenus.create({
        id: 'blockDistraction',
        title: 'Block this Site',
        contexts: IS_FIREFOX ? ['link'] : ['page', 'link']
      }, () => {
        void browser.runtime.lastError;
        Logger.log('BlockDistraction context menu created');
      });
    } else {
      Logger.log('BlockDistraction context menu removed (non-pro mode)');
    }
  });
}

if (browser.contextMenus) {
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'blockDistraction') return;

    const isPro = await ProManager.isPro();
    if (!isPro) {
      Logger.warn('Attempted to block while not in pro mode');
      return;
    }

    const target = resolveContextTarget(info, tab);
    if (!target) {
      Logger.debug('No safe context target resolved');
      return;
    }

    if (!/^https?:/i.test(target.url)) {
      Logger.warn('Unsupported URL scheme:', target.url);
      return;
    }

    try {
      const urlToBlock = normalizeUrlFilter(target.url);

      await rulesManager.addRule(urlToBlock, '');
      Logger.log(
        `Blocked ${target.type} via Context Menu:`,
        urlToBlock
      );

      await closeTabsMatchingRule(urlToBlock);
    } catch (error) {
      Logger.info('Error processing context menu block:', error);
    }
  });
}

async function updateActiveRules() {
  try {
    const rules = await rulesManager.getRules();
    const currentDnrRules = await browser.declarativeNetRequest.getDynamicRules();
    
    const activeRules = rules.filter(rule => rulesManager.isRuleActiveNow(rule));
    const inactiveRules = rules.filter(rule => !rulesManager.isRuleActiveNow(rule));
    
    const removeRuleIds = inactiveRules
      .map(rule => rule.id)
      .filter(id => currentDnrRules.some(dnr => dnr.id === id));
    if (removeRuleIds.length) {
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      Logger.log(`Removed ${removeRuleIds.length} inactive scheduled rules`);
    }
    
    const addRules = [];
    for (const rule of activeRules) {
      if (!currentDnrRules.some(dnr => dnr.id === rule.id)) {
        const dnrRule = await rulesManager.createDNRRule(rule.blockURL, rule.redirectURL);
        dnrRule.id = rule.id;
        addRules.push(dnrRule);
      }
    }
    if (addRules.length) {
      await browser.declarativeNetRequest.updateDynamicRules({ addRules });
      Logger.log(`Added ${addRules.length} active scheduled rules`);
    }
    
  } catch (error) {
    Logger.error("Error updating active rules:", error);
  }
}

async function clearAllDnrRules() {
  try {
    const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
    if (dnrRules.length) {
      const removeRuleIds = dnrRules.map(rule => rule.id);
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      Logger.log(`Cleared ${removeRuleIds.length} DNR rules`);
    }
  } catch (error) {
    Logger.error("Failed to clear DNR rules:", error);
  }
}

async function showUpdates(details) {
  return true;
  try {
    const settings = await SettingsManager.getSettings();
    
    if (details.reason === 'update' && settings.showNotifications === true) {
      const version = browser.runtime.getManifest().version;
      browser.tabs.create({
        url: browser.runtime.getURL(`update/update.html?version=${version}`)
      });
    }
  } catch (error) {
    Logger.error('Error showing updates:', error);
    if (details.reason === 'update') {
      const version = browser.runtime.getManifest().version;
      browser.tabs.create({
        url: browser.runtime.getURL(`update/update.html?version=${version}`)
      });
    }
  }
}

async function validateDnrIntegrity() {
  try {
    const rules = await rulesManager.getRules();
    const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
    
    const storageIds = new Set(rules.map(r => r.id));
    const dnrIds = new Set(dnrRules.map(r => r.id));
    
    const isInSync = storageIds.size === dnrIds.size && [...storageIds].every(id => dnrIds.has(id));
    
    if (!isInSync) {
      Logger.warn("DNR rules out of sync, triggering sync...");
      await updateActiveRules();
    }
    
    return isInSync;
  } catch (error) {
    Logger.error("DNR integrity check failed:", error);
    return false;
  }
}

async function trackBlockedPage(url) {
  try {
    const extensionUrl = browser.runtime.getURL('');
    
    if (url.startsWith(extensionUrl) && url.includes('blocked.html')) {
      const urlObj = new URL(url);
      const blockedUrl = urlObj.searchParams.get('url');
      
      if (blockedUrl) {
        Logger.log(`Recording block: ${blockedUrl}`);
        await StatisticsManager.recordBlock(blockedUrl);
      }
    }
  } catch (error) {
    Logger.error('Error tracking blocked page:', error);
  }
}

async function handleProStatusUpdate(isPro, subscriptionData = {}) {
  try {
    Logger.log(`Service worker received Pro status update: ${isPro}`);
    const updatedCredentials = await ProManager.setProStatusFromWorker(isPro, subscriptionData);
    Logger.log('Pro status updated successfully');
    await updateContextMenu(isPro);
    return updatedCredentials;
  } catch (error) {
    Logger.error('Error handling Pro status update:', error);
    throw error;
  }
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    await trackBlockedPage(tab.url);
  }
});

browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.url && tab.url !== 'about:blank' && tab.url !== 'chrome://newtab/') {
    await trackBlockedPage(tab.url);
  }
});

browser.runtime.onStartup.addListener(async () => {
  Logger.log("Extension startup - syncing DNR rules");
  await updateActiveRules();
  
  const result = await syncLicenseKeyStatus();
  Logger.log('Startup: Pro status is', result.isPro, '- updating context menu...');
  await updateContextMenu(result.isPro);
  
  setTimeout(async () => {
    await validateDnrIntegrity();
  }, 5000);
});

async function initializeExtension(details) {
  Logger.log("Initializing extension state (rules, settings, legacy status)...");
  
  await updateActiveRules();
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
      Logger.log(`New install: isLegacyUser set to ${isLegacy}`);
    } else if (details.reason === 'update') {
      if (credentials.installationDate === null || credentials.isLegacyUser === undefined) {
        await ProManager.updateProStatus(credentials.isPro, {
          ...credentials,
          installationDate: credentials.installationDate || new Date(0).toISOString(),
          isLegacyUser: true
        });
        Logger.log('Migrated existing users to legacy status');
      }
    }
    
    const isPro = await ProManager.isPro();
    await updateContextMenu(isPro);
  } catch (error) {
    Logger.info('Error handling install/update for legacy:', error);
  }
}

async function checkAndRequestPermissions() {
  try {
    let granted;
    if (browser.permissions) {
      granted = await browser.permissions.contains({
        origins: ["*://*/"]
      });
    }
    
    if (granted) {
      Logger.log("Host permission already granted.");
      await initializeExtension(details);
    } else {
      Logger.log("Host permission NOT granted. Opening onboarding page.");
      browser.tabs.create({
        url: browser.runtime.getURL('onboarding/onboarding.html')
      });
    }
  } catch (err) {
    Logger.error("Error checking permissions:", err);
  }
}

browser.runtime.onInstalled.addListener(async (details) => {
  Logger.log(`Extension event: ${details.reason}`);
  
  if (details.reason === 'install') {
    Logger.log("This is a fresh install. Checking permissions...");
    await initializeExtension(details);
    await checkAndRequestPermissions();
  } else if (details.reason === 'update') {
    Logger.log("This is an update. Assuming permissions are granted.");
    await initializeExtension(details);
    await checkAndRequestPermissions();
  } else if (details.reason === 'chrome_update' || details.reason === 'browser_update') {
    Logger.log("Browser updated.");
    await validateDnrIntegrity();
  } else if (details.reason === 'shared_module_update') {
    Logger.log("Shared module updated.");
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'close_current_tab') {
    if (sender.tab && sender.tab.id) {
      browser.tabs.remove(sender.tab.id);
    }
    return;
  }
  
  if (message.type === 'CLOSE_MATCHING_TABS') {
    closeTabsMatchingRule(message.url)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        Logger.error("Close tabs error:", err);
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
      await updateActiveRules();
      Logger.log('Rules updated.');
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
  
  if (message.type === 'permissions_granted') {
    Logger.log("Permissions granted via onboarding.");
    updateActiveRules();
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check_pro_expiry') {
    const syncResult = await syncLicenseKeyStatus();
    await updateContextMenu(syncResult.isPro);
  }
  
  if (alarm.name === 'update_scheduled_rules') {
    await updateActiveRules();
  }
});

browser.alarms.create('check_pro_expiry', {
  delayInMinutes: 30,
  periodInMinutes: 1440
});

browser.alarms.create('update_scheduled_rules', {
  periodInMinutes: 1
});