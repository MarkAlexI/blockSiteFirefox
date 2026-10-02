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

function getWindowsNeedingSafety(tabs, ids) {
  const removeIds = new Set(ids);
  const tabsByWindow = new Map();
  for (const tab of tabs) {
    const key = getWindowKey(tab);
    const windowTabs = tabsByWindow.get(key) || [];
    windowTabs.push(tab);
    tabsByWindow.set(key, windowTabs);
  }
  return [...tabsByWindow]
    .filter(([, windowTabs]) => windowTabs.every(tab => removeIds.has(tab.id)))
    .map(([windowId]) => windowId);
}

function matchesCurrentNavigation(tab, matchesUrl) {
  return Boolean(tab.url && matchesUrl(tab.url)) &&
    (!tab.pendingUrl || matchesUrl(tab.pendingUrl));
}

async function removeStillMatchingTabs(ids, matches, shouldContinue) {
  const candidates = new Set(ids);
  const attemptedWindows = new Set();
  // Each retry follows safety-tab creation, never a timer or idle polling.
  // Bound retries if tabs keep moving between windows during browser awaits.
  for (let pass = 0; pass <= candidates.size + 1; pass += 1) {
    if (!shouldContinue()) return 0;
    const tabs = await browser.tabs.query({});
    if (!shouldContinue()) return 0;
    let currentIds = tabs.filter(tab => candidates.has(tab.id) && matches(tab))
      .map(tab => tab.id);
    if (currentIds.length === 0) return 0;

    const unsafeWindows = getWindowsNeedingSafety(tabs, currentIds);
    const windowsToProtect = unsafeWindows.filter(id => !attemptedWindows.has(id));
    if (windowsToProtect.length > 0) {
      for (const windowId of windowsToProtect) {
        if (!shouldContinue()) return 0;
        attemptedWindows.add(windowId);
        const canTargetWindow = windowId !== null && Boolean(browser.windows);
        await browser.tabs.create(canTargetWindow ? { windowId } : {});
      }
      // Creation can yield to navigation, closure, or a move to another window.
      continue;
    }

    // If a replacement disappeared before the fresh query, preserve that
    // window rather than repeatedly creating tabs or closing its final tab.
    const unprotected = new Set(unsafeWindows);
    currentIds = currentIds.filter(id => !unprotected.has(
      getWindowKey(tabs.find(tab => tab.id === id))
    ));
    if (currentIds.length === 0 || !shouldContinue()) return 0;
    await browser.tabs.remove(currentIds);
    return currentIds.length;
  }
  return 0;
}

function isNonWhitelistedTab(tab, whitelistRules) {
  return matchesCurrentNavigation(tab,
    url => !isBlockedURL([{ url }]) && !isUrlInWhitelist(url, whitelistRules));
}

/** Rechecks one Whitelist candidate and protects its window before removal. */
export async function closeNonWhitelistedTab(tabId, observedUrl, whitelistRules, shouldContinue = () => true) {
  if (!shouldContinue()) return;
  try {
    const tab = await browser.tabs.get(tabId);
    if (!shouldContinue() || tab?.url !== observedUrl || !isNonWhitelistedTab(tab, whitelistRules)) return;
    await removeStillMatchingTabs([tabId],
      current => current.url === observedUrl && isNonWhitelistedTab(current, whitelistRules),
      shouldContinue);
  } catch (error) {
    logger.warn('Error during single non-whitelisted tab closure:', error);
  }
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
    
    const removed = await removeStillMatchingTabs(tabsToRemoveIds,
      tab => matchesCurrentNavigation(tab,
        url => validPatterns.some(pattern => doesUrlMatchBlockRule(url, pattern))), shouldContinue);
    logger.log(`Tabs successfully closed: ${removed}`);
    
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

    const removed = await removeStillMatchingTabs(tabsToRemoveIds,
      tab => isNonWhitelistedTab(tab, whitelistRules), shouldContinue);
    logger.log(`Focus Whitelist: Batch closed non-whitelisted tabs: ${removed}`);

  } catch (e) {
    logger.warn("Error during non-whitelisted tabs closure:", e);
  }
}
