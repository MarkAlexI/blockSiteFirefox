import { getTelemetryConsent, setTelemetryConsent } from './telemetryConsent.js';

export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_ENDPOINT = 'https://blockdistraction.com/api/telemetry';
export const TELEMETRY_TIMEOUT_MS = 10000;
const BASE_BACKOFF_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

function computeBackoff(failureCount) {
  const exponent = Math.max(0, Math.min(5, Number(failureCount || 1) - 1));
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** exponent));
}

export function createTelemetryClient({
  localStorage,
  permissionsApi = globalThis.browser?.permissions,
  store,
  getContext,
  fetchFn = globalThis.fetch?.bind(globalThis),
  endpoint = TELEMETRY_ENDPOINT,
  now = () => Date.now(),
  timeoutMs = TELEMETRY_TIMEOUT_MS
}) {
  let flushPromise = null;

  async function getConsent() {
    return getTelemetryConsent(localStorage, permissionsApi);
  }

  async function setConsent(enabled) {
    const consent = await setTelemetryConsent(localStorage, enabled, now, permissionsApi);
    if (!consent.enabled) await store.clearAll();
    return consent;
  }

  async function runFlush({ force = false } = {}) {
    const consent = await getConsent();
    if (!consent.enabled) return { success: true, sent: false, reason: 'disabled' };
    if (typeof fetchFn !== 'function') return { success: false, sent: false, reason: 'fetch_unavailable' };

    const delivery = await store.getDeliveryState();
    if (!force && Number(delivery.nextAttemptAt) > now()) {
      return { success: true, sent: false, reason: 'backoff' };
    }

    const batches = await store.getPendingBatches();
    if (batches.length === 0) return { success: true, sent: false, reason: 'empty' };

    const payload = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      sentAt: new Date(now()).toISOString(),
      context: await getContext(),
      batches
    };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller?.signal
      });

      if (!response.ok) {
        throw Object.assign(new Error(`Telemetry endpoint returned ${response.status}`), {
          status: response.status
        });
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (body && body.ok === false) {
        throw new Error('Telemetry endpoint rejected the payload');
      }

      const allDates = batches.map(batch => batch.date);
      const acceptedDates = Array.isArray(body?.acceptedDates) ?
        body.acceptedDates.filter(date => allDates.includes(date)) : allDates;

      if (acceptedDates.length > 0) await store.clearDates(acceptedDates);
      await store.setDeliveryState({
        failureCount: 0,
        nextAttemptAt: 0,
        lastSuccessAt: now(),
        lastStatus: response.status
      });

      return {
        success: true,
        sent: true,
        acceptedDates,
        status: response.status
      };
    } catch (error) {
      const failureCount = Math.min(20, (Number(delivery.failureCount) || 0) + 1);
      await store.setDeliveryState({
        failureCount,
        nextAttemptAt: now() + computeBackoff(failureCount),
        lastFailureAt: now(),
        lastStatus: Number(error?.status) || null
      });
      return {
        success: false,
        sent: false,
        reason: error?.name === 'AbortError' ? 'timeout' : 'delivery_failed',
        status: Number(error?.status) || null
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function flush(options = {}) {
    if (flushPromise) return flushPromise;
    flushPromise = runFlush(options).finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  return { getConsent, setConsent, flush };
}
