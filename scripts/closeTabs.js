/**
 * Closes tabs matching the blockURL.
 * Prevents browser window closure if all tabs match.
 * @param {string} blockURL - URL pattern to match
 */
import Logger from '../utils/logger.js';

export async function closeTabsMatchingRules(blockURLs) {
  const logger = new Logger('CloseTabs');
  
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