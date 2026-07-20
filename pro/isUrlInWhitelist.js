/**
 * Checks if a given URL matches any active whitelist rule.
 *
 * @param {string} url - The URL to check.
 * @param {Array<Object>} whitelistRules - Array of rule objects where `isWhitelist` is true.
 * @returns {boolean} `true` if the URL matches at least one active whitelist rule, otherwise `false`.
 */
export function isUrlInWhitelist(url, whitelistRules) {
  if (!url || !Array.isArray(whitelistRules) || whitelistRules.length === 0) {
    return false;
  }

  let hostname = '';
  let fullPath = '';

  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase();
    fullPath = (parsed.hostname + parsed.pathname + parsed.search).toLowerCase();
  } catch (e) {
    return false;
  }

  return whitelistRules.some((rule) => {
    if (rule.disabledByUser) {
      return false;
    }

    const pattern = (rule.blockURL || '').trim().toLowerCase();
    if (!pattern) {
      return false;
    }

    return (
      hostname === pattern ||
      hostname.endsWith('.' + pattern) ||
      fullPath.includes(pattern)
    );
  });
}
