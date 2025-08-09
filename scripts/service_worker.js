import { storageUpdateHandler } from './storageUpdateHandler.js';

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    const { rules } = await browser.storage.sync.get('rules');
    if (rules && Array.isArray(rules)) {
      const changes = {
        rules: {
          newValue: rules
        }
      };
      try {
        await storageUpdateHandler(changes);
        console.log('DNR правила створено (Firefox)');
      } catch (e) {
        console.error('Помилка при створенні правил:', e);
      }
    }
  }
});

const showUpdates = (details) => {
  if (details.reason === 'update') {
    const version = browser.runtime.getManifest().version;
    browser.tabs.create({
      url: browser.runtime.getURL(`update/update.html?version=${version}`)
    });
  }
};

browser.runtime.onInstalled.addListener(showUpdates);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'close_current_tab') {
    if (sender.tab && sender.tab.id) {
      browser.tabs.remove(sender.tab.id);
    }
  }
});
