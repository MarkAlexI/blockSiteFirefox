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

export const REDIRECT_NAVIGATION_STATE_KEY = 'redirectNavigationChainsV1';

// A server redirect is outside the DNR rule graph. Retain only this tab's
// unfinished sequence of already authorized rule targets, until a web document
// or the local blocked page actually finishes. storage.session survives an
// idle worker restart and is cleared on browser exit; old Firefox event pages
// without that API keep the same state in memory.
export function createRedirectNavigationGuard({ tabsApi, runtimeApi, sessionStorage }) {
  let loaded = false, chains = {}, tail = Promise.resolve();
  const enqueue = task => {
    const result = tail.then(task, task);
    tail = result.catch(() => {});
    return result;
  };
  async function load() {
    if (loaded) return;
    const saved = sessionStorage ? (await sessionStorage.get(REDIRECT_NAVIGATION_STATE_KEY))[REDIRECT_NAVIGATION_STATE_KEY] : null;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, value] of Object.entries(saved)) {
        if (!/^\d+$/.test(id) || !Array.isArray(value?.hops) ||
            !value.hops.every(hop => typeof hop === 'string')) continue;
        chains[id] = { hops: value.hops, document: typeof value.document === 'string' ? value.document : null,
          fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : null, blocked: value.blocked === true };
      }
    }
    loaded = true;
  }
  const save = () => sessionStorage?.set({ [REDIRECT_NAVIGATION_STATE_KEY]: chains });
  const current = (tab, url) => tab?.url === url && (!tab.pendingUrl || tab.pendingUrl === url);

  function authorize(sender, verified, { documentToken, isCurrent = () => true } = {}) {
    return enqueue(async () => {
      await load();
      const id = sender.tab?.id;
      if (!Number.isInteger(id) || id < 0 || !isCurrent()) return { allowed: false };
      let tab;
      try { tab = await tabsApi.get(id); } catch { return { allowed: false, obsolete: true }; }
      if (!isCurrent()) return { allowed: false };
      if (!current(tab, sender.url)) return { allowed: false, obsolete: true };
      const fingerprint = JSON.stringify([verified.from, verified.to]);
      const document = sender.documentId ||
        (typeof documentToken === 'string' && /^[\w-]{16,128}$/.test(documentToken) ? documentToken : null);
      const previous = chains[id];
      if (previous?.blocked) return { allowed: false };
      const checkpoint = async (next, decision) => {
        chains[id] = next;
        await save();
        // The first tab read, or the session checkpoint itself, can finish
        // after its redirect document has been replaced. Validate the live
        // tab again before authorizing an effect or recording statistics.
        let latest;
        try { latest = await tabsApi.get(id); } catch { /* The tab was closed. */ }
        if (!isCurrent()) return { allowed: false };
        if (!current(latest, sender.url)) {
          delete chains[id];
          await save();
          return { allowed: false, obsolete: true };
        }
        return decision;
      };
      if (document && previous?.document === document && previous.fingerprint === fingerprint) {
        return { allowed: true, recordRedirect: false };
      }
      if (previous?.hops.includes(fingerprint)) {
        return checkpoint({ ...previous, blocked: true }, { allowed: false, recordBlock: true });
      }
      return checkpoint({ hops: [...(previous?.hops || []), fingerprint], document, fingerprint, blocked: false },
        { allowed: true, recordRedirect: true });
    });
  }

  function completed(tabId, url) {
    // Completion of redirect.html is an intermediary, not a successful web
    // visit. Re-read native completion as a landing page can already have
    // changed its URL through SPA history before this observer resumes.
    const terminal = value => {
      try {
        const parsed = new URL(value);
        return ['http:', 'https:'].includes(parsed.protocol) ||
          parsed.href.split(/[?#]/, 1)[0] === runtimeApi.getURL('blocked.html');
      } catch { return false; }
    };
    if (!terminal(url)) return Promise.resolve();
    return enqueue(async () => {
      await load();
      if (!chains[tabId]) return;
      let tab;
      try { tab = await tabsApi.get(tabId); } catch { return; }
      if (tab?.status !== 'complete' || !terminal(tab.url) ||
          (tab.pendingUrl && tab.pendingUrl !== tab.url)) return;
      delete chains[tabId];
      await save();
    });
  }

  function removed(tabId) {
    return enqueue(async () => { await load(); if (!chains[tabId]) return; delete chains[tabId]; await save(); });
  }
  return { authorize, completed, removed };
}
