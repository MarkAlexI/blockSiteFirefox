/**
 * Closes tabs matching the blockURL.
 * Prevents browser window closure if all tabs match.
 * @param {string} blockURL - URL pattern to match
 */
import Logger from '../utils/logger.js';

export async function closeTabsMatchingRule(blockURL) {
  if (!blockURL || blockURL.trim() === '') return;
  
  const tabs = await browser.tabs.query({});
  const tabsToRemoveIds = [];
  
  for (const tab of tabs) {
    try {
      if (tab.url && tab.url.toLowerCase().includes(blockURL.toLowerCase())) {
        tabsToRemoveIds.push(tab.id);
      }
    } catch (e) {
      Logger.warn("Error checking tab:", tab.id, e);
    }
  }
  
  if (tabsToRemoveIds.length === 0) return;
  
  const allTabsWillBeClosed = tabs.length === tabsToRemoveIds.length;
  
  if (allTabsWillBeClosed) {
    await browser.tabs.create({});
  }
  
  await browser.tabs.remove(tabsToRemoveIds);
}