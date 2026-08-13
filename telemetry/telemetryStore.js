import {
  normalizeCounterName,
  sanitizeTelemetryContext,
  sanitizeTelemetryError
} from './telemetrySanitizer.js';

export const TELEMETRY_BUCKETS_KEY = 'telemetryBuckets';
export const TELEMETRY_DELIVERY_STATE_KEY = 'telemetryDeliveryState';
export const TELEMETRY_RETENTION_DAYS = 7;
export const MAX_TELEMETRY_ERRORS_PER_DAY = 50;

function utcDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isDateWithinRetention(date, now, retentionDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const currentDate = utcDate(now);
  const oldestDate = utcDate(
    now - (Math.max(1, retentionDays) - 1) * 24 * 60 * 60 * 1000
  );
  return date >= oldestDate && date <= currentDate;
}

function sameDateKeys(a, b) {
  const left = Object.keys(a).sort();
  const right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function defaultCreateDeliveryId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random delivery IDs are unavailable');
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cloneErrors(errors) {
  return Array.isArray(errors) ? errors.map(item => ({ ...item })) : [];
}

function hasTelemetryData(bucket) {
  return Object.keys(bucket?.counters || {}).length > 0 ||
    Array.isArray(bucket?.errors) && bucket.errors.length > 0;
}

function createDeliverySnapshot(bucket, deliveryId) {
  return {
    deliveryId,
    counters: { ...(bucket.counters || {}) },
    errors: cloneErrors(bucket.errors)
  };
}

function isDeliverySnapshot(value) {
  return Boolean(value) &&
    typeof value === 'object' &&
    typeof value.deliveryId === 'string' &&
    value.deliveryId.length > 0 &&
    value.counters && typeof value.counters === 'object' &&
    !Array.isArray(value.counters) &&
    Array.isArray(value.errors);
}

function toBatch(bucket, snapshot = null) {
  const source = snapshot || bucket;
  return {
    date: bucket.date,
    ...(snapshot ? { deliveryId: snapshot.deliveryId } : {}),
    ...(bucket.context ? { context: sanitizeTelemetryContext(bucket.context) } : {}),
    counters: { ...(source.counters || {}) },
    errors: cloneErrors(source.errors)
  };
}

export function createTelemetryStore({
  localStorage,
  getConsent,
  getContext = null,
  now = () => Date.now(),
  retentionDays = TELEMETRY_RETENTION_DAYS,
  maxErrorsPerDay = MAX_TELEMETRY_ERRORS_PER_DAY,
  createDeliveryId = defaultCreateDeliveryId
}) {
  let mutationQueue = Promise.resolve();

  function enqueue(operation) {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.catch(() => {});
    return run;
  }

  async function isEnabled() {
    const consent = await getConsent();
    return consent?.enabled === true;
  }

  async function readBuckets() {
    const result = await localStorage.get([TELEMETRY_BUCKETS_KEY]);
    const stored = result?.[TELEMETRY_BUCKETS_KEY];
    return stored && typeof stored === 'object' && !Array.isArray(stored) ?
      structuredClone(stored) : {};
  }

  function pruneBuckets(buckets) {
    const timestamp = now();
    return Object.fromEntries(
      Object.entries(buckets)
        .filter(([date]) => isDateWithinRetention(date, timestamp, retentionDays))
        .sort(([a], [b]) => a.localeCompare(b))
    );
  }

  async function writeBuckets(buckets) {
    await localStorage.set({ [TELEMETRY_BUCKETS_KEY]: pruneBuckets(buckets) });
  }

  async function createBucket(date) {
    let context = null;
    if (typeof getContext === 'function') {
      try {
        context = sanitizeTelemetryContext(await getContext());
      } catch {
        context = null;
      }
    }

    return {
      date,
      ...(context ? { context } : {}),
      counters: {},
      errors: []
    };
  }

  async function getOrCreateBucket(buckets, date) {
    const existing = buckets[date];
    if (existing) {
      if (!existing.context && typeof getContext === 'function') {
        try {
          existing.context = sanitizeTelemetryContext(await getContext());
        } catch {
          // Keep legacy 4.8.0 buckets readable. The client will use its current
          // coarse context as a delivery fallback if no bucket context exists.
        }
      }
      return existing;
    }
    return createBucket(date);
  }

  async function incrementCounter(name, amount = 1) {
    const safeName = normalizeCounterName(name);
    const safeAmount = Math.max(1, Math.min(1000, Math.floor(Number(amount) || 1)));
    if (!safeName || !await isEnabled()) return false;

    return enqueue(async () => {
      if (!await isEnabled()) return false;
      const buckets = pruneBuckets(await readBuckets());
      const date = utcDate(now());
      const bucket = await getOrCreateBucket(buckets, date);
      bucket.counters[safeName] = Math.min(
        Number.MAX_SAFE_INTEGER,
        (Number(bucket.counters[safeName]) || 0) + safeAmount
      );
      buckets[date] = bucket;
      await writeBuckets(buckets);
      return true;
    });
  }

  async function recordError(error) {
    const sanitized = sanitizeTelemetryError(error);
    if (!sanitized || !await isEnabled()) return false;

    return enqueue(async () => {
      if (!await isEnabled()) return false;
      const buckets = pruneBuckets(await readBuckets());
      const date = utcDate(now());
      const bucket = await getOrCreateBucket(buckets, date);
      const existing = bucket.errors.find(item => item.fingerprint === sanitized.fingerprint);

      if (existing) {
        existing.count = Math.min(Number.MAX_SAFE_INTEGER, (existing.count || 0) + 1);
      } else if (bucket.errors.length < Math.max(1, maxErrorsPerDay)) {
        bucket.errors.push({ ...sanitized, count: 1 });
      }

      buckets[date] = bucket;
      await writeBuckets(buckets);
      return true;
    });
  }

  async function getPendingBatches() {
    return enqueue(async () => {
      const stored = await readBuckets();
      const buckets = pruneBuckets(stored);

      if (!sameDateKeys(stored, buckets)) {
        await localStorage.set({ [TELEMETRY_BUCKETS_KEY]: buckets });
      }

      return Object.values(buckets)
        .filter(hasTelemetryData)
        .map(bucket => toBatch(bucket));
    });
  }

  async function preparePendingBatches() {
    return enqueue(async () => {
      const stored = await readBuckets();
      const buckets = pruneBuckets(stored);
      let changed = !sameDateKeys(stored, buckets);
      const prepared = [];

      for (const bucket of Object.values(buckets)) {
        if (!hasTelemetryData(bucket)) continue;

        if (!isDeliverySnapshot(bucket.delivery)) {
          bucket.delivery = createDeliverySnapshot(bucket, createDeliveryId());
          changed = true;
        }

        prepared.push(toBatch(bucket, bucket.delivery));
      }

      if (changed) {
        await localStorage.set({ [TELEMETRY_BUCKETS_KEY]: buckets });
      }

      return prepared;
    });
  }

  async function acknowledgeBatches(acceptedBatches) {
    const snapshots = Array.isArray(acceptedBatches) ? acceptedBatches : [];
    if (snapshots.length === 0) return false;

    return enqueue(async () => {
      const buckets = await readBuckets();

      for (const snapshot of snapshots) {
        const date = snapshot?.date;
        const bucket = date ? buckets[date] : null;
        if (!bucket) continue;

        if (snapshot.deliveryId) {
          if (!isDeliverySnapshot(bucket.delivery) ||
              bucket.delivery.deliveryId !== snapshot.deliveryId) {
            continue;
          }
        }

        for (const [name, sentValue] of Object.entries(snapshot.counters || {})) {
          const remaining = (Number(bucket.counters?.[name]) || 0) - (Number(sentValue) || 0);
          if (remaining > 0) {
            bucket.counters[name] = remaining;
          } else if (bucket.counters) {
            delete bucket.counters[name];
          }
        }

        const sentErrors = new Map(
          cloneErrors(snapshot.errors)
            .map(item => [item.fingerprint, Number(item.count) || 0])
        );

        bucket.errors = cloneErrors(bucket.errors)
          .map(item => {
            const remaining = (Number(item.count) || 0) - (sentErrors.get(item.fingerprint) || 0);
            return { ...item, count: remaining };
          })
          .filter(item => item.count > 0);

        delete bucket.delivery;

        if (!hasTelemetryData(bucket)) {
          delete buckets[date];
        }
      }

      await writeBuckets(buckets);
      return true;
    });
  }

  async function clearDates(dates) {
    const dateSet = new Set(Array.isArray(dates) ? dates : []);
    if (dateSet.size === 0) return false;

    return enqueue(async () => {
      const buckets = await readBuckets();
      for (const date of dateSet) delete buckets[date];
      await writeBuckets(buckets);
      return true;
    });
  }

  async function clearAll() {
    return enqueue(async () => {
      await localStorage.set({
        [TELEMETRY_BUCKETS_KEY]: {},
        [TELEMETRY_DELIVERY_STATE_KEY]: {}
      });
      return true;
    });
  }

  async function getDeliveryState() {
    const result = await localStorage.get([TELEMETRY_DELIVERY_STATE_KEY]);
    const stored = result?.[TELEMETRY_DELIVERY_STATE_KEY];
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }

  async function setDeliveryState(state) {
    await localStorage.set({ [TELEMETRY_DELIVERY_STATE_KEY]: { ...state } });
  }

  return {
    incrementCounter,
    recordError,
    getPendingBatches,
    preparePendingBatches,
    acknowledgeBatches,
    clearDates,
    clearAll,
    getDeliveryState,
    setDeliveryState
  };
}
