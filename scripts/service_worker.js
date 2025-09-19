import { RulesManager } from '../rules/rulesManager.js';
import { SettingsManager } from '../options/settings.js';
import { StatisticsManager } from '../pro/statisticsManager.js';
import { ProManager } from '../pro/proManager.js';

const rulesManager = new RulesManager();

async function updateContextMenu(isPro) {
  if (!browser.contextMenus) {
    console.log('contextMenus API not available on this platform');
    return;
  }
  
  try {
    await browser.contextMenus.remove('blockDistraction').catch(() => {});
    
    if (isPro) {
      await browser.contextMenus.create({
        id: 'blockDistraction',
        title: 'BlockDistraction',
        contexts: ['link']
      });
      console.log('BlockDistraction context menu created');
    } else {
      console.log('BlockDistraction context menu removed (non-pro mode)');
    }
  } catch (error) {
    console.info('Error updating context menu:', error);
  }
}

if (browser.contextMenus) {
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'blockDistraction' && info.linkUrl) {
      const isPro = await ProManager.isPro();
      if (!isPro) {
        console.warn('Attempted to block while not in pro mode');
        return;
      }
      
      try {
        await rulesManager.addRule(info.linkUrl, '');
        console.log('Blocked URL:', info.linkUrl);
      } catch (error) {
        console.info('Error blocking URL:', error);
      }
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
      console.log(`Removed ${removeRuleIds.length} inactive scheduled rules`);
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
      console.log(`Added ${addRules.length} active scheduled rules`);
    }
    
  } catch (error) {
    console.error("Error updating active rules:", error);
  }
}

async function clearAllDnrRules() {
  try {
    const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
    if (dnrRules.length) {
      const removeRuleIds = dnrRules.map(rule => rule.id);
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      console.log(`Cleared ${removeRuleIds.length} DNR rules`);
    }
  } catch (error) {
    console.error("Failed to clear DNR rules:", error);
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
    console.error('Error showing updates:', error);
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
      console.warn("DNR rules out of sync, triggering sync...");
      await syncDnrFromStorage();
    }
    
    return isInSync;
  } catch (error) {
    console.error("DNR integrity check failed:", error);
    return false;
  }
}

async function trackBlockedPage(url) {
  try {
    const extensionUrl = browser.runtime.getURL('');
    
    if (url.startsWith(extensionUrl) && url.includes('blocked.html')) {
      const urlObj = new URL(url);
      const blockedUrl = urlObj.searchParams.get('url') ||
        urlObj.searchParams.get('blocked') ||
        urlObj.searchParams.get('site');
      
      if (blockedUrl) {
        console.log(`Recording block: ${blockedUrl}`);
        await StatisticsManager.recordBlock(blockedUrl);
      }
    }
  } catch (error) {
    console.error('Error tracking blocked page:', error);
  }
}

async function handleProStatusUpdate(isPro, subscriptionData = {}) {
  try {
    console.log(`Service worker received Pro status update: ${isPro}`);
    const updatedCredentials = await ProManager.setProStatusFromWorker(isPro, subscriptionData);
    console.log('Pro status updated successfully:', updatedCredentials);
    await updateContextMenu(isPro);
    return updatedCredentials;
  } catch (error) {
    console.error('Error handling Pro status update:', error);
    throw error;
  }
}

async function checkProStatusExpiry() {
  try {
    const credentials = await ProManager.getCredentials();
    
    if (credentials.isPro && credentials.expiryDate) {
      const isExpired = new Date() > new Date(credentials.expiryDate);
      
      if (isExpired) {
        console.log('Pro subscription expired, updating status');
        await ProManager.setProStatusFromWorker(false);
        return false;
      }
    }
    
    return credentials.isPro;
  } catch (error) {
    console.error('Error checking Pro status expiry:', error);
    return false;
  }
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && changeInfo.url) {
    await trackBlockedPage(changeInfo.url);
  }
});

browser.tabs.onCreated.addListener(async (tab) => {
  if (tab.url && tab.url !== 'about:blank' && tab.url !== 'chrome://newtab/') {
    await trackBlockedPage(tab.url);
  }
});

browser.runtime.onStartup.addListener(async () => {
  console.log("Extension startup - syncing DNR rules");
  await checkProStatusExpiry();
  await updateActiveRules();
  
  setTimeout(async () => {
    await validateDnrIntegrity();
  }, 5000);
});

browser.runtime.onInstalled.addListener(async (details) => {
  console.log("Extension installed/updated - syncing DNR rules");
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
      console.log(`New install: isLegacyUser set to ${isLegacy}`);
    } else if (details.reason === 'update') {
      if (credentials.installationDate === null || credentials.isLegacyUser === undefined) {
        await ProManager.updateProStatus(credentials.isPro, {
          ...credentials,
          installationDate: credentials.installationDate || new Date(0).toISOString(),
          isLegacyUser: true
        });
        console.log('Migrated existing users to legacy status');
      }
    }
    
    const isPro = await ProManager.isPro();
    await updateContextMenu(isPro);
  } catch (error) {
    console.info('Error handling install/update for legacy:', error);
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'close_current_tab') {
    if (sender.tab && sender.tab.id) {
      browser.tabs.remove(sender.tab.id);
    }
  }
  
  if (message.type === 'record_block') {
    StatisticsManager.recordBlock(message.url);
  }
  
  if (message.type === 'update_pro_status') {
    handleProStatusUpdate(message.isPro, message.subscriptionData)
      .then(result => {
        sendResponse({ success: true, credentials: result });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
  
  if (message.type === 'check_pro_status') {
    ProManager.isPro()
      .then(isPro => {
        sendResponse({ isPro });
      })
      .catch(error => {
        sendResponse({ isPro: false, error: error.message });
      });
    return true;
  }
  
  if (message.type === 'get_pro_credentials') {
    ProManager.getCredentials()
      .then(credentials => {
        sendResponse({ credentials });
      })
      .catch(error => {
        sendResponse({ credentials: ProManager.defaultCredentials, error: error.message });
      });
    return true;
  }
  
  if (message.type === 'reload_rules') {
    await updateActiveRules();
    console.log('Rules updated.');
  }
  
  if (message.type === 'pro_status_changed') {
    updateContextMenu(message.isPro);
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check_pro_expiry') {
    const isPro = await checkProStatusExpiry();
    await updateContextMenu(isPro);
  }
  
  if (alarm.name === 'update_scheduled_rules') {
    await updateActiveRules();
  }
});

browser.alarms.create('check_pro_expiry', {
  delayInMinutes: 30,
  periodInMinutes: 30
});

browser.alarms.create('update_scheduled_rules', {
  periodInMinutes: 1
});