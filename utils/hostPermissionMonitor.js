export const REQUIRED_HOST_ORIGINS = ['*://*/*'];
export const PERMISSION_CHECK_PERSIST_INTERVAL_MS = 15 * 60 * 1000;

export function affectsRequiredHostAccess(origins = []) {
  return Array.isArray(origins) && origins.some(origin =>
    REQUIRED_HOST_ORIGINS.includes(origin) || origin === '<all_urls>'
  );
}

export function createHostPermissionMonitor({
  permissionsApi,
  tabsApi,
  runtimeApi,
  diagnosticStore,
  logger = console,
  now = () => Date.now()
}) {
  let inFlight = null;

  async function openOnboarding() {
    const onboardingUrl = runtimeApi.getURL('onboarding/onboarding.html');
    const tabs = await tabsApi.query({ url: onboardingUrl });
    if (tabs.length > 0) return false;
    await tabsApi.create({ url: onboardingUrl });
    return true;
  }

  async function runCheck({
    reason = 'unknown',
    notifyIfMissing = false,
    assumeMissing = false
  } = {}) {
    const previousState = await diagnosticStore.getState();
    const previousCheck = previousState?.lastPermissionCheck;
    const previousHostAccess = previousCheck?.hostAccess;

    let granted = true;
    if (assumeMissing) {
      granted = false;
    } else if (typeof permissionsApi?.contains === 'function') {
      granted = await permissionsApi.contains({ origins: REQUIRED_HOST_ORIGINS });
    } else {
      logger.warn('Permissions API not available. Assuming host access is granted.');
    }

    const transitionedToMissing = granted === false && previousHostAccess !== false;
    const transitionedToGranted = granted === true && previousHostAccess === false;
    const checkedAt = now();
    const previousTimestamp = Number(previousCheck?.timestamp);
    const shouldPersistCheck =
      reason !== 'scheduled_alarm' ||
      previousHostAccess !== granted ||
      previousCheck?.error != null ||
      !Number.isFinite(previousTimestamp) ||
      previousTimestamp <= 0 ||
      checkedAt < previousTimestamp ||
      checkedAt - previousTimestamp >= PERMISSION_CHECK_PERSIST_INTERVAL_MS;

    if (shouldPersistCheck) {
      await diagnosticStore.updateState({
        lastPermissionCheck: {
          timestamp: checkedAt,
          hostAccess: granted,
          reason
        }
      });
    }

    if (transitionedToMissing) {
      await diagnosticStore.recordEvent('warn', 'permissions', 'host_access_missing', { reason });
    } else if (transitionedToGranted) {
      await diagnosticStore.recordEvent('info', 'permissions', 'host_access_restored', { reason });
    }

    let notified = false;
    if (!granted && (notifyIfMissing || transitionedToMissing)) {
      logger.warn(`Host permission is missing (${reason}). Opening onboarding.`);
      notified = await openOnboarding();
    }

    return {
      granted,
      previousHostAccess,
      transitionedToMissing,
      transitionedToGranted,
      notified
    };
  }

  function check(options = {}) {
    if (inFlight) return inFlight;
    inFlight = runCheck(options)
      .catch(async error => {
        logger.error('Error checking host permissions:', error);
        await diagnosticStore.updateState({
          lastPermissionCheck: {
            timestamp: now(),
            hostAccess: false,
            reason: options.reason || 'unknown',
            error: error?.message || String(error)
          }
        });
        await diagnosticStore.recordEvent('error', 'permissions', 'check_failed', {
          reason: options.reason || 'unknown',
          error
        });
        return {
          granted: false,
          previousHostAccess: null,
          transitionedToMissing: false,
          transitionedToGranted: false,
          notified: false,
          error
        };
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { check };
}
