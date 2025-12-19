/**
 * Safely resolves a URL to block from a context menu click.
 *
 * Design goals:
 * - Never block a page by accident (Firefox-safe)
 * - Block a link only when linkUrl is explicitly provided and non-empty
 * - Allow page blocking only when page context is explicit
 *
 * @param {object} info - contextMenus.onClicked info
 * @param {object} tab  - active tab
 * @returns {{ type: 'link' | 'page', url: string } | null}
 */
export function resolveContextTarget(info, tab) {
  // 1. Explicit link blocking
  if (typeof info.linkUrl === 'string' && info.linkUrl.length > 0) {
    return {
      type: 'link',
      url: info.linkUrl
    };
  }
  
  // 2. Page blocking (pageUrl OR tab.url)
  if (typeof info.pageUrl === 'string' && info.pageUrl.length > 0) {
    return {
      type: 'page',
      url: info.pageUrl
    };
  }
  
  if (tab?.url) {
    return {
      type: 'page',
      url: tab.url
    };
  }
  
  return null;
}