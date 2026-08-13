export const TELEMETRY_CONSENT_KEY = 'telemetryConsent';
export const TELEMETRY_CONSENT_VERSION = 1;
export const TELEMETRY_DATA_COLLECTION_PERMISSION = 'technicalAndInteraction';

async function readStoredConsent(localStorage) {
  const result = await localStorage.get([TELEMETRY_CONSENT_KEY]);
  const stored = result?.[TELEMETRY_CONSENT_KEY];

  if (!stored || typeof stored !== 'object' || stored.version !== TELEMETRY_CONSENT_VERSION) {
    return {
      version: TELEMETRY_CONSENT_VERSION,
      enabled: false,
      decidedAt: null
    };
  }

  return {
    version: TELEMETRY_CONSENT_VERSION,
    enabled: stored.enabled === true,
    decidedAt: Number.isFinite(stored.decidedAt) ? stored.decidedAt : null
  };
}

async function getBuiltInConsent(permissionsApi) {
  if (typeof permissionsApi?.getAll !== 'function') {
    return { supported: false, enabled: false };
  }

  try {
    const permissions = await permissionsApi.getAll();
    if (!Object.prototype.hasOwnProperty.call(permissions || {}, 'data_collection')) {
      return { supported: false, enabled: false };
    }

    return {
      supported: true,
      enabled: Array.isArray(permissions.data_collection) &&
        permissions.data_collection.includes(TELEMETRY_DATA_COLLECTION_PERMISSION)
    };
  } catch {
    // If the permissions API exists but cannot be queried, fail closed instead
    // of falling back to a previously stored local opt-in.
    return { supported: true, enabled: false };
  }
}

async function storeDecision(localStorage, enabled, now) {
  const consent = {
    version: TELEMETRY_CONSENT_VERSION,
    enabled: enabled === true,
    decidedAt: now()
  };

  await localStorage.set({ [TELEMETRY_CONSENT_KEY]: consent });
  return consent;
}

export async function getTelemetryConsent(localStorage, permissionsApi = globalThis.browser?.permissions) {
  const [stored, builtIn] = await Promise.all([
    readStoredConsent(localStorage),
    getBuiltInConsent(permissionsApi)
  ]);

  if (builtIn.supported) {
    return {
      version: TELEMETRY_CONSENT_VERSION,
      enabled: builtIn.enabled,
      decidedAt: stored.decidedAt,
      source: 'firefox_builtin'
    };
  }

  return {
    ...stored,
    source: 'local'
  };
}

export async function setTelemetryConsent(
  localStorage,
  enabled,
  now = () => Date.now(),
  permissionsApi = globalThis.browser?.permissions
) {
  const builtIn = await getBuiltInConsent(permissionsApi);
  const effectiveEnabled = builtIn.supported ? builtIn.enabled : enabled === true;
  const stored = await storeDecision(localStorage, effectiveEnabled, now);

  return {
    ...stored,
    source: builtIn.supported ? 'firefox_builtin' : 'local'
  };
}

export function requestTelemetryConsentFromUserAction(permissionsApi, enabled) {
  const request = {
    data_collection: [TELEMETRY_DATA_COLLECTION_PERMISSION]
  };

  // Firefox requires permissions.request() to be initiated directly from a
  // user-action handler. Do not await getAll() or any other asynchronous work
  // before starting the request. The caller already feature-detects the native
  // data-collection permission and invokes this helper only for that path.
  if (enabled === true) {
    if (typeof permissionsApi?.request !== 'function') return Promise.resolve(null);
    return permissionsApi.request(request);
  }

  if (typeof permissionsApi?.remove !== 'function') return Promise.resolve(null);
  return permissionsApi.remove(request);
}
