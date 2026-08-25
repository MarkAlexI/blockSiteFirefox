import { normalizePathRule } from './normalizePathRule.js';
import { normalizePathSegment } from './normalizePathSegment.js';
import { getProtectedRequestDomains } from '../utils/protectedDomains.js';

/**
 * Builds one dynamic DNR rule from an already validated stored rule.
 * User-entered matching semantics are preserved exactly as before.
 */
export function createDnrRule({
  id,
  blockURL,
  redirectURL,
  defaultRedirectURL,
  intermediaryRedirectURL
}) {
  const trimmedBlock = blockURL.trim();
  const filter = normalizePathRule(trimmedBlock);
  const urlFilter = `||${filter}`;
  const normalizedBlockURL = normalizePathSegment(trimmedBlock);

  let action;

  if (redirectURL && redirectURL.trim() !== '') {
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

  return (id, blockURL, redirectURL) => createDnrRule({
    id,
    blockURL,
    redirectURL,
    defaultRedirectURL,
    intermediaryRedirectURL
  });
}
