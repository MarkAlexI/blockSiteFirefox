import { getTelemetryConsent, setTelemetryConsent } from './telemetryConsent.js';
import { sanitizeTelemetryContext } from './telemetrySanitizer.js';

export const TELEMETRY_SCHEMA_VERSION = 2;
export const TELEMETRY_ENDPOINT = 'https://blockdistraction.com/api/telemetry';
export const TELEMETRY_TIMEOUT_MS = 10000;
const BASE_BACKOFF_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const RESTORE_RETRY_DELAY_MS = 60 * 1000;

function computeBackoff(failureCount) {
  const exponent = Math.max(0, Math.min(5, Number(failureCount || 1) - 1));
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** exponent));
}

function contextKey(context) {
  return JSON.stringify(context);
}

function createDeliveryBatch(batch) {
  return {
    date: batch.date,
    deliveryId: batch.deliveryId,
    counters: { ...(batch.counters || {}) },
    errors: Array.isArray(batch.errors) ? batch.errors.map(item => ({ ...item })) : []
  };
}

function groupBatchesByContext(batches, fallbackContext) {
  const groups = new Map();

  for (const batch of batches) {
    const context = sanitizeTelemetryContext(batch.context || fallbackContext);
    const key = contextKey(context);
    if (!groups.has(key)) groups.set(key, { context, batches: [] });
    groups.get(key).batches.push(createDeliveryBatch(batch));
  }

  return [...groups.values()];
}

export function createTelemetryClient({
  localStorage,
  permissionsApi = globalThis.browser?.permissions,
  store,
  getContext,
  fetchFn = globalThis.fetch?.bind(globalThis),
  endpoint = TELEMETRY_ENDPOINT,
  now = () => Date.now(),
  timeoutMs = TELEMETRY_TIMEOUT_MS,
  scheduleRetry = null,
  cancelRetry = null
}) {
  let flushPromise = null;
  let deliveryGeneration = 0;
  let deliveryBlocked = false;
  let activeRequestController = null;
  let lifecycleQueue = Promise.resolve();

  function enqueueLifecycle(operation) {
    const result = lifecycleQueue.then(operation, operation);
    lifecycleQueue = result.catch(() => {});
    return result;
  }

  function createDisabledResult() {
    return { success: true, sent: false, reason: 'disabled' };
  }

  function createConsentRevokedError() {
    return Object.assign(new Error('Telemetry consent was revoked'), {
      code: 'consent_revoked'
    });
  }

  async function getConsent() {
    return getTelemetryConsent(localStorage, permissionsApi);
  }

  async function isDeliveryAllowed(generation) {
    if (deliveryBlocked || generation !== deliveryGeneration) return false;
    const consent = await getConsent();
    return !deliveryBlocked && generation === deliveryGeneration && consent.enabled === true;
  }

  async function safelyScheduleRetry(timestamp) {
    if (typeof scheduleRetry !== 'function') return;
    try {
      await scheduleRetry(timestamp);
    } catch {
      // Retry scheduling must never break extension behavior or telemetry state.
    }
  }

  async function safelyCancelRetry() {
    if (typeof cancelRetry !== 'function') return;
    try {
      await cancelRetry();
    } catch {
      // Alarm cleanup is best-effort and must not affect extension behavior.
    }
  }

  async function setConsent(enabled) {
    if (enabled !== true) {
      deliveryBlocked = true;
      deliveryGeneration++;
      activeRequestController?.abort();
    }

    return enqueueLifecycle(async () => {
      const consent = await setTelemetryConsent(localStorage, enabled, now, permissionsApi);
      if (!consent.enabled) {
        deliveryBlocked = true;
        if (enabled === true) {
          deliveryGeneration++;
          activeRequestController?.abort();
        }
        await store.clearAll();
        await safelyCancelRetry();
      } else {
        deliveryGeneration++;
        deliveryBlocked = false;
      }
      return consent;
    });
  }

  async function setFailureState(delivery, error, status = null, generation) {
    const failureCount = Math.min(20, (Number(delivery.failureCount) || 0) + 1);
    const nextAttemptAt = now() + computeBackoff(failureCount);
    const reason = error?.name === 'AbortError' ? 'timeout' :
      error?.code === 'partial_accept' ? 'partial_accept' : 'delivery_failed';

    return enqueueLifecycle(async () => {
      if (!await isDeliveryAllowed(generation)) return createDisabledResult();
      await store.setDeliveryState({
        ...delivery,
        failureCount,
        nextAttemptAt,
        lastFailureAt: now(),
        lastFailureReason: reason,
        lastStatus: Number(status ?? error?.status) || null
      });
      if (!await isDeliveryAllowed(generation)) return createDisabledResult();
      await safelyScheduleRetry(nextAttemptAt);

      return {
        success: false,
        reason,
        status: Number(status ?? error?.status) || null,
        nextAttemptAt
      };
    });
  }

  async function sendGroup(group, generation) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeRequestController = controller;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      if (!await isDeliveryAllowed(generation)) throw createConsentRevokedError();
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          sentAt: new Date(now()).toISOString(),
          context: group.context,
          batches: group.batches
        }),
        signal: controller?.signal
      });

      if (!await isDeliveryAllowed(generation)) throw createConsentRevokedError();
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

      if (!await isDeliveryAllowed(generation)) throw createConsentRevokedError();
      if (body && body.ok === false) {
        throw Object.assign(new Error('Telemetry endpoint rejected the payload'), {
          status: response.status
        });
      }

      const allDates = group.batches.map(batch => batch.date);
      const acceptedDates = Array.isArray(body?.acceptedDates) ?
        body.acceptedDates.filter(date => allDates.includes(date)) : allDates;

      if (acceptedDates.length > 0) {
        const acceptedBatches = group.batches.filter(batch => acceptedDates.includes(batch.date));
        const acknowledged = await enqueueLifecycle(async () => {
          if (!await isDeliveryAllowed(generation)) return false;
          if (typeof store.acknowledgeBatches === 'function') {
            await store.acknowledgeBatches(acceptedBatches);
          } else {
            // Compatibility for older test doubles and temporary integrations.
            await store.clearDates(acceptedDates);
          }
          return true;
        });
        if (!acknowledged) throw createConsentRevokedError();
      }

      if (acceptedDates.length !== allDates.length) {
        throw Object.assign(new Error('Telemetry endpoint accepted only part of the payload'), {
          code: 'partial_accept',
          status: response.status,
          acceptedDates
        });
      }

      return { acceptedDates, status: response.status };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (activeRequestController === controller) activeRequestController = null;
    }
  }

  async function runFlush({ force = false } = {}) {
    const generation = deliveryGeneration;
    const consent = await getConsent();
    if (!consent.enabled || deliveryBlocked || generation !== deliveryGeneration) {
      await safelyCancelRetry();
      return createDisabledResult();
    }
    if (typeof fetchFn !== 'function') {
      return { success: false, sent: false, reason: 'fetch_unavailable' };
    }

    const delivery = await store.getDeliveryState();
    if (!await isDeliveryAllowed(generation)) return createDisabledResult();

    if (!force && Number(delivery.nextAttemptAt) > now()) {
      const scheduled = await enqueueLifecycle(async () => {
        if (!await isDeliveryAllowed(generation)) return false;
        await safelyScheduleRetry(Number(delivery.nextAttemptAt));
        return isDeliveryAllowed(generation);
      });
      if (!scheduled) return createDisabledResult();
      return { success: true, sent: false, reason: 'backoff' };
    }

    const batches = typeof store.preparePendingBatches === 'function' ?
      await store.preparePendingBatches() : await store.getPendingBatches();
    if (batches.length === 0) {
      const cleared = await enqueueLifecycle(async () => {
        if (!await isDeliveryAllowed(generation)) return false;
        if (Number(delivery.nextAttemptAt) > 0 || Number(delivery.failureCount) > 0) {
          await store.setDeliveryState({
            ...delivery,
            failureCount: 0,
            nextAttemptAt: 0
          });
        }
        if (!await isDeliveryAllowed(generation)) return false;
        await safelyCancelRetry();
        return true;
      });
      if (!cleared) return createDisabledResult();
      return { success: true, sent: false, reason: 'empty' };
    }

    const fallbackContext = sanitizeTelemetryContext(await getContext());
    if (!await isDeliveryAllowed(generation)) return createDisabledResult();
    const groups = groupBatchesByContext(batches, fallbackContext);
    const acceptedDates = [];
    let lastStatus = null;

    try {
      for (const group of groups) {
        const result = await sendGroup(group, generation);
        acceptedDates.push(...result.acceptedDates);
        lastStatus = result.status;
      }

      const recorded = await enqueueLifecycle(async () => {
        if (!await isDeliveryAllowed(generation)) return false;
        await store.setDeliveryState({
          ...delivery,
          failureCount: 0,
          nextAttemptAt: 0,
          lastSuccessAt: now(),
          lastStatus
        });
        if (!await isDeliveryAllowed(generation)) return false;
        await safelyCancelRetry();
        return true;
      });
      if (!recorded) return createDisabledResult();

      return {
        success: true,
        sent: true,
        acceptedDates,
        status: lastStatus
      };
    } catch (error) {
      if (error?.code === 'consent_revoked' || !await isDeliveryAllowed(generation)) {
        return createDisabledResult();
      }
      if (Array.isArray(error?.acceptedDates)) {
        acceptedDates.push(...error.acceptedDates.filter(date => !acceptedDates.includes(date)));
      }
      const failure = await setFailureState(delivery, error, error?.status, generation);
      if (failure.reason === 'disabled') return failure;
      return {
        ...failure,
        sent: acceptedDates.length > 0,
        acceptedDates
      };
    }
  }

  function flush(options = {}) {
    if (flushPromise) return flushPromise;
    flushPromise = runFlush(options).finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  async function restoreRetry() {
    const generation = deliveryGeneration;
    if (!await isDeliveryAllowed(generation)) {
      await safelyCancelRetry();
      return false;
    }

    const delivery = await store.getDeliveryState();
    return enqueueLifecycle(async () => {
      if (!await isDeliveryAllowed(generation)) return false;

      const nextAttemptAt = Number(delivery.nextAttemptAt) || 0;
      if (nextAttemptAt <= 0) {
        await safelyCancelRetry();
        return false;
      }

      await safelyScheduleRetry(Math.max(nextAttemptAt, now() + RESTORE_RETRY_DELAY_MS));
      return isDeliveryAllowed(generation);
    });
  }

  return { getConsent, setConsent, flush, restoreRetry };
}
