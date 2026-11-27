import { createDnrRuleMatcher } from '../rules/urlRuleMatcher.js';

function readRedirectPage(value, runtimeApi) {
  try {
    const page = new URL(value);
    const base = new URL(page.href);
    base.search = '';
    base.hash = '';
    if (base.href !== runtimeApi.getURL('redirect.html') || page.hash) return null;
    const from = page.searchParams.get('from');
    const to = page.searchParams.get('to');
    if (!from || !to || page.searchParams.getAll('from').length !== 1 ||
        page.searchParams.getAll('to').length !== 1) return null;
    const destination = new URL(to);
    if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return null;
    // The factory encodes the block pattern before URLSearchParams encodes it.
    return { page: page.href, from: decodeURIComponent(from), to: destination.href };
  } catch {
    return null;
  }
}

function hasRedirectCycle(source, destination, rules, runtimeApi) {
  // Only currently installed main-frame rules can participate. Unique native
  // priorities use the same overlap order as the normal navigation decision.
  const matchRule = createDnrRuleMatcher(rules);
  const visited = new Set([source]);
  let url = destination;
  while (true) {
    const next = matchRule(url);
    if (!next || next.action?.type !== 'redirect') return false;
    const redirect = readRedirectPage(next.action.redirect?.url, runtimeApi);
    // A packaged blocked page, an allowed request, or an invalid intermediary
    // terminates the chain. Those cases must not reject a legitimate redirect.
    if (!redirect) return false;
    if (visited.has(next)) return true;
    visited.add(next);
    url = redirect.to;
  }
}

/**
 * Restricts custom redirects to destinations in currently installed DNR rules.
 * An exact rule URL match limits the target; it does not prove a DNR trigger.
 */
export async function authorizeRedirect({ sender, runtimeApi, dnrApi, isCurrent }) {
  if (sender?.id !== runtimeApi.id ||
      (sender.frameId !== undefined && sender.frameId !== 0)) return null;
  const verified = readRedirectPage(sender.url, runtimeApi);
  if (!verified || !isCurrent()) return null;
  const rules = await dnrApi.getDynamicRules();
  if (!isCurrent()) return null;
  const rule = rules.find(candidate =>
    candidate.action?.type === 'redirect' &&
    candidate.action.redirect?.url === verified.page &&
    candidate.condition?.resourceTypes?.includes('main_frame')
  );
  if (!rule || hasRedirectCycle(rule, verified.to, rules, runtimeApi)) return null;
  return { from: verified.from, to: verified.to };
}
