import { getRuleAssignment } from '../rules/ruleAssignments.js';
import { GENERAL_RULE_LIST_ID } from '../rules/ruleListsManager.js';

/** The existing Whitelist scope: hostname/label text and a bounded path prefix.
 * Scheme, port, query, credentials and hash do not narrow that scope.
 * Parse saved rows without rewriting them or turning filter tokens into wildcards.
 */
export function normalizeWhitelistTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const input = value.trim();
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!hostname) return null;
    return {
      hostname,
      path: url.pathname.replace(/\/+$/, '').toLowerCase(),
      domain: hostname.includes('.'),
      protocol: url.protocol
    };
  } catch {
    return null;
  }
}

export function isValidWhitelistTarget(value) {
  const target = normalizeWhitelistTarget(value);
  return Boolean(target && ['http:', 'https:'].includes(target.protocol)
    && target.hostname.replace(/\./g, '') && !target.hostname.includes('*'));
}

export function getWhitelistTargetKey(value) {
  const target = normalizeWhitelistTarget(value);
  return target ? JSON.stringify([target.hostname, target.path]) : null;
}

export function matchesWhitelistHostname(hostname, target) {
  return target.domain
    ? hostname === target.hostname || hostname.endsWith(`.${target.hostname}`)
    : hostname.split('.').some(label => label.includes(target.hostname));
}

export function matchesWhitelistTarget(url, target) {
  if (!target || !matchesWhitelistHostname(url.hostname.toLowerCase(), target)) return false;
  const path = url.pathname.toLowerCase();
  return !target.path || path === target.path || path.startsWith(`${target.path}/`);
}

function isScopeSubset(left, right) {
  const hostnameSubset = right.domain
    ? left.domain && (left.hostname === right.hostname || left.hostname.endsWith(`.${right.hostname}`))
    : left.domain
      ? matchesWhitelistHostname(left.hostname, right)
      : left.hostname.includes(right.hostname);
  const pathSubset = !right.path || left.path === right.path || left.path.startsWith(`${right.path}/`);
  return hostnameSubset && pathSubset;
}

export function areWhitelistTargetsRedundant(left, right) {
  return Boolean(left && right && (isScopeSubset(left, right) || isScopeSubset(right, left)));
}

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
    if (typeof rule?.blockURL !== 'string') return false;

    if (getRuleAssignment(rule, GENERAL_RULE_LIST_ID)?.disabledByUser === true) {
      return false;
    }

    return matchesWhitelistTarget(parsedUrl, normalizeWhitelistTarget(rule.blockURL));
  });
}
