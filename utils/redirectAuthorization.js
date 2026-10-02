/**
 * Restricts custom redirects to destinations in currently installed DNR rules.
 * An exact rule URL match limits the target; it does not prove a DNR trigger.
 */
export async function authorizeRedirect({ sender, runtimeApi, dnrApi, isCurrent }) {
  if (sender?.id !== runtimeApi.id ||
      (sender.frameId !== undefined && sender.frameId !== 0)) return null;

  let page;
  try {
    page = new URL(sender.url);
    const base = new URL(page.href);
    base.search = '';
    base.hash = '';
    if (base.href !== runtimeApi.getURL('redirect.html') || page.hash) return null;
  } catch {
    return null;
  }

  if (!isCurrent()) return null;
  const rules = await dnrApi.getDynamicRules();
  if (!isCurrent()) return null;
  const rule = rules.find(candidate =>
    candidate.action?.type === 'redirect' &&
    candidate.action.redirect?.url === page.href &&
    candidate.condition?.resourceTypes?.includes('main_frame')
  );
  if (!rule) return null;

  try {
    const verified = new URL(rule.action.redirect.url);
    const from = verified.searchParams.get('from');
    const to = verified.searchParams.get('to');
    if (!from || !to || verified.searchParams.getAll('from').length !== 1 ||
        verified.searchParams.getAll('to').length !== 1) return null;
    const destination = new URL(to);
    if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return null;
    // The factory encodes the block pattern before URLSearchParams encodes it.
    return { from: decodeURIComponent(from), to: destination.href };
  } catch {
    return null;
  }
}
