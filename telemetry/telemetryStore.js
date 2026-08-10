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

export function createTelemetryStore({
  localStorage,
  getConsent,
  getContext = null,
  now = () => Date.now(),
  retentionDays = TELEMETRY_RETENTION_DAYS,
  maxErrorsPerDay = MAX_TELEMETRY_ERRORS_PER_DAY
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

      // Retention is a storage guarantee, not only a delivery filter.
      if (!sameDateKeys(stored, buckets)) {
        await localStorage.set({ [TELEMETRY_BUCKETS_KEY]: buckets });
      }

      return Object.values(buckets)
        .filter(bucket =>
          Object.keys(bucket.counters || {}).length > 0 ||
          Array.isArray(bucket.errors) && bucket.errors.length > 0
        )
        .map(bucket => ({
          date: bucket.date,
          ...(bucket.context ? { context: sanitizeTelemetryContext(bucket.context) } : {}),
          counters: { ...(bucket.counters || {}) },
          errors: Array.isArray(bucket.errors) ? bucket.errors.map(item => ({ ...item })) : []
        }));
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

        for (const [name, sentValue] of Object.entries(snapshot.counters || {})) {
          const remaining = (Number(bucket.counters?.[name]) || 0) - (Number(sentValue) || 0);
          if (remaining > 0) {
            bucket.counters[name] = remaining;
          } else if (bucket.counters) {
            delete bucket.counters[name];
          }
        }

        const sentErrors = new Map(
          (Array.isArray(snapshot.errors) ? snapshot.errors : [])
            .map(item => [item.fingerprint, Number(item.count) || 0])
        );

        bucket.errors = (Array.isArray(bucket.errors) ? bucket.errors : [])
          .map(item => {
            const remaining = (Number(item.count) || 0) - (sentErrors.get(item.fingerprint) || 0);
            return { ...item, count: remaining };
          })
          .filter(item => item.count > 0);

        const hasCounters = Object.keys(bucket.counters || {}).length > 0;
        const hasErrors = bucket.errors.length > 0;
        if (!hasCounters && !hasErrors) {
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
    acknowledgeBatches,
    clearDates,
    clearAll,
    getDeliveryState,
    setDeliveryState
  };
}
