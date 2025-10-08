/**
 * Closes all tabs whose URL contains the given blockURL string.
 * If all tabs are matched to be closed, it first creates a new tab
 * to prevent the browser window from closing.
 * @param {string} blockURL — The full or partial URL used to match and close tabs.
 */
export function closeTabsMatchingRule(blockURL) {
  if (!blockURL || blockURL.trim() === '') return;

  browser.tabs.query({}, (tabs) => {
    const tabsToRemoveIds = [];
    tabs.forEach((tab) => {
      try {
        if (tab.url && tab.url.includes(blockURL)) {
          tabsToRemoveIds.push(tab.id);
        }
      } catch (e) {
        console.info("Error on tab handling:", e);
      }
    });

    if (tabsToRemoveIds.length === 0) {
      return;
    }
    
    const allTabsWillBeClosed = tabs.length === tabsToRemoveIds.length;

    if (allTabsWillBeClosed) {
      browser.tabs.create({}, () => {
        browser.tabs.remove(tabsToRemoveIds);
      });
    } else {
      browser.tabs.remove(tabsToRemoveIds);
    }
  });
}
