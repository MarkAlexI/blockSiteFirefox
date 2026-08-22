/**
 * Closes tabs matching the blockURL.
 * Prevents browser window closure if all tabs match.
 * @param {Array<string>} blockURLs - Array of URL patterns to match
 * @param {Function} shouldContinue - Returns false when a newer DNR snapshot supersedes this cleanup
 */
import Logger from '../utils/logger.js';
import { isBlockedURL } from './isBlockedURL.js';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';
import { doesUrlMatchBlockRule } from '../rules/urlRuleMatcher.js';

const logger = new Logger('CloseTabs');

function getWindowKey(tab) {
  return Number.isInteger(tab.windowId) ? tab.windowId : null;
}

async function createSafetyTabs(tabs, tabsToRemoveIds, shouldContinue) {
  const removeIds = new Set(tabsToRemoveIds);
  const tabsByWindow = new Map();

  for (const tab of tabs) {
    const windowKey = getWindowKey(tab);
    const windowTabs = tabsByWindow.get(windowKey) || [];
    windowTabs.push(tab);
    tabsByWindow.set(windowKey, windowTabs);
  }

  for (const [windowId, windowTabs] of tabsByWindow) {
    const removesEntireWindow = windowTabs.length > 0 &&
      windowTabs.every(tab => removeIds.has(tab.id));
    if (!removesEntireWindow) continue;
    if (!shouldContinue()) return false;

    const canTargetWindow = windowId !== null && Boolean(browser.windows);
    await browser.tabs.create(canTargetWindow ? { windowId } : {});
  }

  return shouldContinue();
}

export async function closeTabsMatchingRules(blockURLs, shouldContinue = () => true) {
  const validPatterns = blockURLs
    .map(url => url?.trim().toLowerCase())
    .filter(url => url && url !== '');
  
  if (validPatterns.length === 0 || !shouldContinue()) return;
  
  try {
    const tabs = await browser.tabs.query({});
    if (!shouldContinue()) return;
    const tabsToRemoveIds = [];
    
    for (const tab of tabs) {
      if (!tab.url) continue;
      
      const shouldClose = validPatterns.some(pattern => doesUrlMatchBlockRule(tab.url, pattern));
      
      if (shouldClose) {
        tabsToRemoveIds.push(tab.id);
      }
    }
    
    if (tabsToRemoveIds.length === 0) return;
    
    if (!await createSafetyTabs(tabs, tabsToRemoveIds, shouldContinue)) return;
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
 * @param {Function} shouldContinue - Returns false when a newer Focus state supersedes this cleanup
 */
export async function closeNonWhitelistedTabs(whitelistRules, shouldContinue = () => true) {
  if (!shouldContinue()) return;

  try {
    const tabs = await browser.tabs.query({});
    if (!shouldContinue()) return;
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

    if (!await createSafetyTabs(tabs, tabsToRemoveIds, shouldContinue)) return;
    await browser.tabs.remove(tabsToRemoveIds);
    logger.log(`Focus Whitelist: Batch closed non-whitelisted tabs: ${tabsToRemoveIds.length}`);

  } catch (e) {
    logger.warn("Error during non-whitelisted tabs closure:", e);
  }
}
