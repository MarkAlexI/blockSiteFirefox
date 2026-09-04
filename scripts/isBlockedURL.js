import { isProtectedRequestHostname } from '../utils/protectedDomains.js';

const SUPPORTED_WEB_PROTOCOLS = new Set(['http:', 'https:']);
const KNOWN_NON_WEB_PROTOCOLS = new Set([
  'about:',
  'blob:',
  'chrome:',
  'chrome-extension:',
  'data:',
  'devtools:',
  'edge:',
  'file:',
  'filesystem:',
  'ftp:',
  'javascript:',
  'kiwi:',
  'mailto:',
  'moz-extension:',
  'opera:',
  'resource:',
  'safari-extension:',
  'view-source:',
  'ws:',
  'wss:'
]);
const BARE_HOST_PORT_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:\d{1,5}(?:[/?#]|$)/i;

/**
 * Distinguishes explicit URL schemes from the extension's flexible bare
 * domain, path, and partial-target syntax. Common host:port input remains
 * available even though its port is not part of the DNR matching contract.
 */
export function hasUnsupportedExplicitScheme(value) {
  const target = typeof value === 'string' ? value.trim() : '';
  if (!target) return false;

  const match = /^([a-z][a-z0-9+.-]*):/i.exec(target);
  if (!match) return false;

  const protocol = `${match[1].toLowerCase()}:`;
  if (SUPPORTED_WEB_PROTOCOLS.has(protocol)) return false;
  if (KNOWN_NON_WEB_PROTOCOLS.has(protocol)) return true;
  return !BARE_HOST_PORT_PATTERN.test(target);
}

/**
 * Checks whether the current tab URL is blocked from processing.
 *
 * Returns `true` for unsupported schemes, internal browser pages, and
 * extension-related URLs that should not be handled by the extension logic.
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

  if (hasUnsupportedExplicitScheme(url)) return true;

  const blockedPatterns = [
    /^about:/,
    /extension:\/\//,
    /^https:\/\/addons\.mozilla\.org(?:\/|$)/,
    /^devtools:/,
    /^view-source:/,
    /\/\/newtab/
  ];
  const protectedProjectPatterns = [/blockdistraction/i, /markdigital\.cc/i, /ext\.pp\.ua/i];

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    let pastedHostname = '';
    try {
      pastedHostname = new URL(`https://${url}`).hostname;
    } catch {
      // Invalid inputs retain the existing browser and project pattern checks.
    }

    if (isProtectedRequestHostname(pastedHostname)) return true;
    return [...blockedPatterns, ...protectedProjectPatterns]
      .some(pattern => pattern.test(url));
  }

  const safeUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const hostname = parsed.hostname.toLowerCase();
  const isProtectedProjectHost = [
    /(?:^|\.)blockdistraction\.com$/i,
    /(?:^|\.)markdigital\.cc$/i,
    /(?:^|\.)ext\.pp\.ua$/i
  ].some(pattern => pattern.test(hostname));

  return blockedPatterns.some(pattern => pattern.test(safeUrl)) ||
    isProtectedRequestHostname(hostname) ||
    isProtectedProjectHost;
}
