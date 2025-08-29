import { RulesManager } from '../rules/rulesManager.js';

const rulesManager = new RulesManager();

async function syncDnrFromStorage() {
  try {
    const rules = await rulesManager.getRules();
    
    if (!rules || !rules.length) {
      await clearAllDnrRules();
      return;
    }
    
    const dnrRules = await browser.declarativeNetRequest.getDynamicRules();

    const missing = rules.filter(storedRule => 
      !dnrRules.some(dnrRule => dnrRule.id === storedRule.id)
    );

    const extra = dnrRules.filter(dnrRule => 
      !rules.some(storedRule => storedRule.id === dnrRule.id)
    );

    if (missing.length) {
      const addRules = [];
      for (const rule of missing) {
        try {
          const dnrRule = await rulesManager.createDNRRule(rule.blockURL, rule.redirectURL);
          dnrRule.id = rule.id;
          addRules.push(dnrRule);
        } catch (error) {
          console.warn(`Failed to create DNR rule for ${rule.blockURL}:`, error);
        }
      }
      
      if (addRules.length) {
        await browser.declarativeNetRequest.updateDynamicRules({ addRules });
        console.log(`Synced ${addRules.length} missing DNR rules`);
      }
    }

    if (extra.length) {
      const removeRuleIds = extra.map(rule => rule.id);
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      console.log(`Removed ${removeRuleIds.length} extra DNR rules`);
    }
    
  } catch (error) {
    console.error("DNR sync error:", error);

    try {
      console.log("Attempting full migration...");
      await rulesManager.migrateRules();
    } catch (migrationError) {
      console.error("Migration failed:", migrationError);
    }
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

function showUpdates(details) {
  browser.storage.sync.get(['settings'], ({ settings }) => {
    const showNotifications = settings?.showNotifications === true;
    
    if (details.reason === 'update' && showNotifications === true) {
      const version = browser.runtime.getManifest().version;
      browser.tabs.create({
        url: browser.runtime.getURL(`update/update.html?version=${version}`)
      });
    }
  });
}

async function validateDnrIntegrity() {
  try {
    const rules = await rulesManager.getRules();
    const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
    
    const storageIds = new Set(rules.map(r => r.id));
    const dnrIds = new Set(dnrRules.map(r => r.id));
    
    const isInSync = storageIds.size === dnrIds.size && 
                   [...storageIds].every(id => dnrIds.has(id));
    
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

browser.runtime.onStartup.addListener(async () => {
  console.log("Extension startup - syncing DNR rules");
  await syncDnrFromStorage();

  setTimeout(async () => {
    await validateDnrIntegrity();
  }, 5000);
});

browser.runtime.onInstalled.addListener(async (details) => {
  console.log("Extension installed/updated - syncing DNR rules");
  await syncDnrFromStorage();
  showUpdates(details);
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'close_current_tab') {
    if (sender.tab && sender.tab.id) {
      browser.tabs.remove(sender.tab.id);
    }
  }
});
