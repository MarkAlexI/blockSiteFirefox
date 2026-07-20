/**
 * Closes tabs matching the blockURL.
 * Prevents browser window closure if all tabs match.
 * @param {Array<string>} blockURLs - Array of URL patterns to match
 */
import Logger from '../utils/logger.js';
import { isBlockedURL } from './isBlockedURL.js';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';

const logger = new Logger('CloseTabs');

export async function closeTabsMatchingRules(blockURLs) {
  const validPatterns = blockURLs
    .map(url => url?.trim().toLowerCase())
    .filter(url => url && url !== '');
  
  if (validPatterns.length === 0) return;
  
  try {
    const tabs = await browser.tabs.query({});
    const tabsToRemoveIds = [];
    
    for (const tab of tabs) {
      if (!tab.url) continue;
      
      const tabUrlLower = tab.url.toLowerCase();
      const shouldClose = validPatterns.some(pattern => tabUrlLower.includes(pattern));
      
      if (shouldClose) {
        tabsToRemoveIds.push(tab.id);
      }
    }
    
    if (tabsToRemoveIds.length === 0) return;
    
    const allTabsWillBeClosed = tabs.length === tabsToRemoveIds.length;
    if (allTabsWillBeClosed) {
      await browser.tabs.create({});
    }
    
    await browser.tabs.remove(tabsToRemoveIds);
    logger.log(`Tabs successfully closed: ${tabsToRemoveIds.length}`);
    
  } catch (e) {
    logger.warn("Error during batch tab closure:", e);
  }
}

/**
 * Closes all tabs that DO NOT match any active whitelist rule during Whitelist Focus Mode.
 * Safely ignores internal/protected browser pages and prevents window closure.
 * 
 * @param {Array<Object>} whitelistRules - Active rules with isWhitelist === true
 */
export async function closeNonWhitelistedTabs(whitelistRules) {
  try {
    const tabs = await browser.tabs.query({});
    const tabsToRemoveIds = [];

    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;

      if (isBlockedURL([{ url: tab.url }])) {
        continue;
      }

      if (!isUrlInWhitelist(tab.url, whitelistRules)) {
        tabsToRemoveIds.push(tab.id);
      }
    }

    if (tabsToRemoveIds.length === 0) return;

    const allTabsWillBeClosed = tabs.length === tabsToRemoveIds.length;
    if (allTabsWillBeClosed) {
      await browser.tabs.create({});
    }

    await browser.tabs.remove(tabsToRemoveIds);
    logger.log(`Focus Whitelist: Batch closed non-whitelisted tabs: ${tabsToRemoveIds.length}`);

  } catch (e) {
    logger.warn("Error during non-whitelisted tabs closure:", e);
  }
}
