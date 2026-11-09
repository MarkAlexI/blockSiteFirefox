import { normalizePathRule } from './normalizePathRule.js';
import { normalizePathSegment } from './normalizePathSegment.js';
import { getProtectedRequestDomains } from '../utils/protectedDomains.js';
import { isValidURL } from '../scripts/isValidURL.js';

const BLOCK_REASONS = new Set(['always', 'schedule', 'daily_limit', 'focus']);

export class InvalidDnrUrlFilterError extends TypeError {
  constructor() {
    super('Invalid DNR URL filter.');
  }
}

/**
 * Validate the compiled filter, not URL completeness: short fragments remain
 * supported, and valid Unicode URLs are serialized before the ASCII check.
 */
export function createDnrUrlFilter(blockURL) {
  const trimmedBlock = typeof blockURL === 'string' ? blockURL.trim() : '';
  if (!trimmedBlock) throw new InvalidDnrUrlFilterError();
  const normalizedBlock = normalizePathRule(trimmedBlock);
  // A target such as 'www.' disappears during normalization. A bare domain
  // anchor would match unrelated sites instead of the user's URL fragment.
  if (!normalizedBlock) throw new InvalidDnrUrlFilterError();
  const urlFilter = `||${normalizedBlock}`;

  // DNR forbids non-ASCII filters and a wildcard immediately after ||.
  // Other supported filter constructs retain their existing behavior.
  if (/[^\x00-\x7F]/.test(urlFilter) || urlFilter.startsWith('||*')) {
    throw new InvalidDnrUrlFilterError();
  }

  return urlFilter;
}

/**
 * Builds one dynamic DNR rule from an already validated stored rule.
 * User-entered matching semantics are preserved exactly as before.
 */
export function createDnrRule({
  id,
  blockURL,
  redirectURL,
  blockReason,
  defaultRedirectURL,
  intermediaryRedirectURL
}) {
  const urlFilter = createDnrUrlFilter(blockURL);
  const trimmedBlock = blockURL.trim();
  const normalizedBlockURL = normalizePathSegment(trimmedBlock);

  let action;

  if (redirectURL && isValidURL(redirectURL.trim())) {
    const finalRedirectUrl = new URL(intermediaryRedirectURL);
    finalRedirectUrl.searchParams.set('from', normalizedBlockURL);

    try {
      const parsedRedirect = new URL(redirectURL.trim());
      finalRedirectUrl.searchParams.set('to', parsedRedirect.href);
    } catch {
      finalRedirectUrl.searchParams.set('to', redirectURL.trim());
    }

    action = {
      type: 'redirect',
      redirect: { url: finalRedirectUrl.href }
    };
  } else {
    const finalRedirectUrl = new URL(defaultRedirectURL);
    finalRedirectUrl.searchParams.set('url', normalizedBlockURL);
    if (BLOCK_REASONS.has(blockReason)) {
      finalRedirectUrl.searchParams.set('reason', blockReason);
    }
    action = {
      type: 'redirect',
      redirect: { url: finalRedirectUrl.href }
    };
  }

  return {
    id: Math.floor(Number(id)),
    condition: {
      urlFilter,
      excludedRequestDomains: [...getProtectedRequestDomains()],
      resourceTypes: ['main_frame']
    },
    priority: 100,
    action
  };
}

/**
 * Binds browser runtime URLs once and returns the compact callback expected by
 * the DNR synchronizer.
 */
export function createDnrRuleFactory(getRuntimeUrl) {
  const defaultRedirectURL = getRuntimeUrl('blocked.html');
  const intermediaryRedirectURL = getRuntimeUrl('redirect.html');

  return (id, blockURL, redirectURL, blockReason) => createDnrRule({
    id,
    blockURL,
    redirectURL,
    blockReason,
    defaultRedirectURL,
    intermediaryRedirectURL
  });
}
