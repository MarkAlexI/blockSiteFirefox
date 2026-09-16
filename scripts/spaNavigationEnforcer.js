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
  const generations = new Map();

  async function enforce(tabId, observedUrl) {
    if (!Number.isInteger(tabId) || typeof observedUrl !== 'string' || observedUrl === '') {
      return { status: 'invalid_input' };
    }

    const generation = (generations.get(tabId) || 0) + 1;
    generations.set(tabId, generation);
    logger.log('SPA navigation: URL change observed.');

    try {
      if (shouldSkipUrl(observedUrl)) {
        logger.log('SPA navigation: Protected or unsupported URL skipped.');
        return { status: 'skipped_url' };
      }

      const resolution = await resolveNavigation(observedUrl);
      if (generations.get(tabId) !== generation) {
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
        generations.get(tabId) !== generation ||
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
      if (generations.get(tabId) === generation) generations.delete(tabId);
    }
  }

  return { enforce };
}
