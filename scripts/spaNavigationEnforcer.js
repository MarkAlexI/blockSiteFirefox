const NOOP_LOGGER = Object.freeze({
  log() {},
  info() {}
});

/**
 * Re-applies the active DNR navigation decision after a same-document URL
 * change. A fresh tab read prevents a delayed async result from redirecting a
 * newer URL, while the per-tab generation prevents older checks from winning.
 */
export function createSpaNavigationEnforcer({
  tabsApi,
  resolveNavigation,
  shouldSkipUrl = () => false,
  logger = NOOP_LOGGER
}) {
  const pendingChecks = new Map();

  function invalidate(tabId = null) {
    if (tabId === null) pendingChecks.clear();
    else pendingChecks.delete(tabId);
  }

  async function enforce(tabId, observedUrl) {
    if (!Number.isInteger(tabId) || typeof observedUrl !== 'string' || observedUrl === '') {
      return { status: 'invalid_input' };
    }

    // Identity cannot be reused after a newer completed check removes its entry.
    const token = {};
    pendingChecks.set(tabId, token);
    logger.log('SPA navigation: URL change observed.');

    try {
      if (shouldSkipUrl(observedUrl)) {
        logger.log('SPA navigation: Protected or unsupported URL skipped.');
        return { status: 'skipped_url' };
      }

      const resolution = await resolveNavigation(observedUrl);
      if (pendingChecks.get(tabId) !== token) {
        logger.log('SPA navigation: Superseded check ignored.');
        return { status: 'superseded' };
      }
      if (!resolution?.redirectUrl) {
        logger.log('SPA navigation: No active rule matched.');
        return { status: 'no_match' };
      }

      let currentTab;
      try {
        currentTab = await tabsApi.get(tabId);
      } catch {
        logger.log('SPA navigation: Tab is no longer available.');
        return { status: 'tab_unavailable' };
      }

      if (
        pendingChecks.get(tabId) !== token ||
        currentTab?.url !== observedUrl
      ) {
        logger.log('SPA navigation: Stale URL ignored.');
        return { status: 'stale_url' };
      }
      if (shouldSkipUrl(currentTab.url) || currentTab.url === resolution.redirectUrl) {
        logger.log('SPA navigation: Redirect loop avoided.');
        return { status: 'skipped_destination' };
      }

      await tabsApi.update(tabId, { url: resolution.redirectUrl });
      logger.log('SPA navigation: Active rule applied.');
      return { status: 'redirected' };
    } finally {
      if (pendingChecks.get(tabId) === token) pendingChecks.delete(tabId);
    }
  }

  return { enforce, invalidate };
}
