export const STATISTICS_HISTORY_DAYS = 30;

const DAILY_COUNTER_KEYS = new Set(['blocked', 'redirected', 'focusSessions']);

function toNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

export function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function createEmptyDailyEntry() {
  return {
    blocked: 0,
    redirected: 0,
    focusSessions: 0
  };
}

export function createDefaultStatistics(now = new Date()) {
  const today = now.toDateString();
  return {
    totalBlocked: 0,
    blockedToday: 0,
    totalRedirects: 0,
    redirectsToday: 0,
    successfulFocusSessions: 0,
    creationDate: today,
    lastResetDate: today,
    dailyHistory: {}
  };
}

export function normalizeDailyHistory(history, now = new Date()) {
  const normalized = {};
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const oldest = new Date(today);
  oldest.setDate(oldest.getDate() - (STATISTICS_HISTORY_DAYS - 1));

  if (!history || typeof history !== 'object' || Array.isArray(history)) {
    return normalized;
  }

  for (const [key, value] of Object.entries(history)) {
    const date = parseLocalDateKey(key);
    if (!date || date < oldest || date > today) continue;
    const entry = value && typeof value === 'object' ? value : {};
    normalized[key] = {
      blocked: toNonNegativeInteger(entry.blocked),
      redirected: toNonNegativeInteger(entry.redirected),
      focusSessions: toNonNegativeInteger(entry.focusSessions)
    };
  }

  return normalized;
}

export function normalizeStatistics(stats, now = new Date()) {
  const defaults = createDefaultStatistics(now);
  const source = stats && typeof stats === 'object' ? stats : {};
  const todayDateString = now.toDateString();
  const todayKey = getLocalDateKey(now);
  const sameDay = source.lastResetDate === todayDateString;
  const dailyHistory = normalizeDailyHistory(source.dailyHistory, now);

  const blockedToday = sameDay ? toNonNegativeInteger(source.blockedToday) : 0;
  const redirectsToday = sameDay ? toNonNegativeInteger(source.redirectsToday) : 0;

  if (blockedToday > 0 || redirectsToday > 0) {
    const todayEntry = dailyHistory[todayKey] || createEmptyDailyEntry();
    todayEntry.blocked = Math.max(todayEntry.blocked, blockedToday);
    todayEntry.redirected = Math.max(todayEntry.redirected, redirectsToday);
    dailyHistory[todayKey] = todayEntry;
  }

  return {
    totalBlocked: toNonNegativeInteger(source.totalBlocked),
    blockedToday,
    totalRedirects: toNonNegativeInteger(source.totalRedirects),
    redirectsToday,
    successfulFocusSessions: toNonNegativeInteger(source.successfulFocusSessions),
    creationDate: typeof source.creationDate === 'string' && source.creationDate ? source.creationDate : defaults.creationDate,
    lastResetDate: todayDateString,
    dailyHistory
  };
}

export function incrementDailyHistory(stats, counter, now = new Date()) {
  if (!DAILY_COUNTER_KEYS.has(counter)) {
    throw new TypeError(`Unsupported statistics counter: ${counter}`);
  }

  const normalized = normalizeStatistics(stats, now);
  const key = getLocalDateKey(now);
  const entry = normalized.dailyHistory[key] || createEmptyDailyEntry();
  entry[counter] += 1;
  normalized.dailyHistory[key] = entry;
  return normalized;
}

export function buildStatisticsSeries(stats, days = STATISTICS_HISTORY_DAYS, now = new Date()) {
  const count = Math.max(1, Math.min(STATISTICS_HISTORY_DAYS, Math.floor(Number(days) || STATISTICS_HISTORY_DAYS)));
  const normalized = normalizeStatistics(stats, now);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const series = [];

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(date.getDate() - offset);
    const dateKey = getLocalDateKey(date);
    const entry = normalized.dailyHistory[dateKey] || createEmptyDailyEntry();
    series.push({
      dateKey,
      date,
      blocked: entry.blocked,
      redirected: entry.redirected,
      focusSessions: entry.focusSessions
    });
  }

  return series;
}
