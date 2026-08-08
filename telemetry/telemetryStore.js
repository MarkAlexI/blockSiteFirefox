import { normalizeCounterName, sanitizeTelemetryError } from './telemetrySanitizer.js';

export const TELEMETRY_BUCKETS_KEY = 'telemetryBuckets';
export const TELEMETRY_DELIVERY_STATE_KEY = 'telemetryDeliveryState';
export const TELEMETRY_RETENTION_DAYS = 7;
export const MAX_TELEMETRY_ERRORS_PER_DAY = 50;

function utcDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function emptyBucket(date) {
  return { date, counters: {}, errors: [] };
}

function isDateWithinRetention(date, now, retentionDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const currentDate = utcDate(now);
  const oldestDate = utcDate(
    now - (Math.max(1, retentionDays) - 1) * 24 * 60 * 60 * 1000
  );
  return date >= oldestDate && date <= currentDate;
}

export function createTelemetryStore({
  localStorage,
  getConsent,
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

  async function incrementCounter(name, amount = 1) {
    const safeName = normalizeCounterName(name);
    const safeAmount = Math.max(1, Math.min(1000, Math.floor(Number(amount) || 1)));
    if (!safeName || !await isEnabled()) return false;

    return enqueue(async () => {
      if (!await isEnabled()) return false;
      const buckets = pruneBuckets(await readBuckets());
      const date = utcDate(now());
      const bucket = buckets[date] || emptyBucket(date);
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
      const bucket = buckets[date] || emptyBucket(date);
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
    await mutationQueue;
    const buckets = pruneBuckets(await readBuckets());
    const normalized = Object.values(buckets)
      .filter(bucket =>
        Object.keys(bucket.counters || {}).length > 0 ||
        Array.isArray(bucket.errors) && bucket.errors.length > 0
      )
      .map(bucket => ({
        date: bucket.date,
        counters: { ...(bucket.counters || {}) },
        errors: Array.isArray(bucket.errors) ? bucket.errors.map(item => ({ ...item })) : []
      }));

    return normalized;
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
    clearDates,
    clearAll,
    getDeliveryState,
    setDeliveryState
  };
}
