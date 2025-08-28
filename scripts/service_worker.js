import { normalizeUrlFilter } from './normalizeUrlFilter.js'; 

function createDnrRuleFromStored(storedRule) {
  const filter = normalizeUrlFilter(storedRule.blockURL);
  const urlFilter = `||${filter}`;
  const action = storedRule.redirectURL ?
    { type: "redirect", redirect: { url: storedRule.redirectURL } } :
    { type: "redirect", redirect: { url: browser.runtime.getURL("blocked.html") } };
  
  return {
    id: storedRule.id,
    condition: { urlFilter, resourceTypes: ["main_frame"] },
    priority: 100,
    action
  };
}

async function syncDnrFromStorage() {
  try {
    const { rules: storedRules } = await browser.storage.sync.get('rules');
    if (!storedRules || !storedRules.length) return;
    
    const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
    
    const missing = storedRules.filter(sr => !dnrRules.some(dr => dr.id === sr.id));
    if (missing.length) {
      const addRules = missing.map(sr => createDnrRuleFromStored(sr));
      await browser.declarativeNetRequest.updateDynamicRules({ addRules });
    }
    
    const extra = dnrRules.filter(dr => !storedRules.some(sr => sr.id === dr.id));
    if (extra.length) {
      const removeRuleIds = extra.map(dr => dr.id);
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
  } catch (e) {
    console.error("DNR sync error:", e);
  }
}

const showUpdates = (details) => {
  browser.storage.sync.get(['settings'], ({ settings }) => {
    const showNotifications = settings?.showNotifications === true;
    
    if (details.reason === 'update' && showNotifications === true) {
      const version = browser.runtime.getManifest().version;
      browser.tabs.create({
        url: browser.runtime.getURL(`update/update.html?version=${version}`)
      });
    }
  });
};

browser.runtime.onStartup.addListener(syncDnrFromStorage);
browser.runtime.onInstalled.addListener(syncDnrFromStorage);
browser.runtime.onInstalled.addListener(showUpdates);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'close_current_tab') {
    if (sender.tab && sender.tab.id) {
      browser.tabs.remove(sender.tab.id);
    }
  }
});
