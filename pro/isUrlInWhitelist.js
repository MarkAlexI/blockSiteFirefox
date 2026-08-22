import { getRuleAssignment } from '../rules/ruleAssignments.js';
import { GENERAL_RULE_LIST_ID } from '../rules/ruleListsManager.js';

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

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }

  return whitelistRules.some((rule) => {
    if (getRuleAssignment(rule, GENERAL_RULE_LIST_ID)?.disabledByUser === true) {
      return false;
    }

    const pattern = String(rule.blockURL || '').trim();
    if (!pattern) {
      return false;
    }

    let parsedPattern;
    try {
      parsedPattern = new URL(
        /^[a-z][a-z\d+.-]*:\/\//i.test(pattern) ? pattern : `https://${pattern}`
      );
    } catch {
      return false;
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const allowedHostname = parsedPattern.hostname.toLowerCase().replace(/^www\./, '');
    if (!allowedHostname) return false;

    const hostnameMatches = allowedHostname.includes('.')
      ? hostname === allowedHostname || hostname.endsWith(`.${allowedHostname}`)
      : hostname.split('.').some(label => label.includes(allowedHostname));
    if (!hostnameMatches) return false;

    const allowedPath = parsedPattern.pathname.replace(/\/+$/, '').toLowerCase();
    if (!allowedPath) return true;

    const actualPath = parsedUrl.pathname.toLowerCase();
    return actualPath === allowedPath || actualPath.startsWith(`${allowedPath}/`);
  });
}
