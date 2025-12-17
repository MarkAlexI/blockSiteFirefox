/**
 * Checks whether the current tab URL is blocked from processing.
 *
 * Returns `true` for internal browser pages and extension-related URLs
 * that should not be handled by the extension logic.
 *
 * @param {Array<browser.tabs.Tab>|Array<chrome.tabs.Tab>|null|undefined} tabs
 * An array of tabs (usually the result of `tabs.query`).
 *
 * @returns {boolean}
 * `true` if the URL is blocked or tabs are missing, otherwise `false`.
 */

export function isBlockedURL(tabs) {
  if (!tabs) return true;
  const url = tabs[0]?.url || '';
  
  const blockedPatterns = [
    /^about:/,
    /^moz-extension:\/\//,
    /^https:\/\/addons\.mozilla\.org\//,
    /^devtools:/,
    /^view-source:/,
    /^data:/
  ];
  
  return blockedPatterns.some(pattern => pattern.test(url));
}