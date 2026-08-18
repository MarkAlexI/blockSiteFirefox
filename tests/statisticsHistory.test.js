import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATISTICS_HISTORY_DAYS,
  buildStatisticsSeries,
  getLocalDateKey,
  incrementDailyHistory,
  normalizeStatistics
} from '../pro/statisticsHistory.js';

test('legacy current-day counters seed the first history entry without inventing older days', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0);
  const stats = normalizeStatistics({
    totalBlocked: 20,
    blockedToday: 4,
    totalRedirects: 9,
    redirectsToday: 2,
    successfulFocusSessions: 3,
    creationDate: 'Mon Aug 10 2026',
    lastResetDate: now.toDateString()
  }, now);

  assert.deepEqual(stats.dailyHistory, {
    '2026-08-18': { blocked: 4, redirected: 2, focusSessions: 0 }
  });
  assert.equal(stats.totalBlocked, 20);
  assert.equal(stats.successfulFocusSessions, 3);
});

test('daily counters roll over locally while retained history remains available', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0);
  const stats = normalizeStatistics({
    totalBlocked: 5,
    blockedToday: 5,
    totalRedirects: 1,
    redirectsToday: 1,
    successfulFocusSessions: 0,
    creationDate: 'Mon Aug 17 2026',
    lastResetDate: new Date(2026, 7, 17).toDateString(),
    dailyHistory: {
      '2026-08-17': { blocked: 5, redirected: 1, focusSessions: 0 }
    }
  }, now);

  assert.equal(stats.blockedToday, 0);
  assert.equal(stats.redirectsToday, 0);
  assert.deepEqual(stats.dailyHistory['2026-08-17'], { blocked: 5, redirected: 1, focusSessions: 0 });
  assert.equal(stats.lastResetDate, now.toDateString());
});

test('history retains only the latest 30 local calendar days', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0);
  const stats = normalizeStatistics({
    lastResetDate: now.toDateString(),
    dailyHistory: {
      '2026-07-19': { blocked: 1, redirected: 0, focusSessions: 0 },
      '2026-07-20': { blocked: 2, redirected: 0, focusSessions: 0 },
      '2026-08-18': { blocked: 3, redirected: 1, focusSessions: 1 },
      '2026-08-19': { blocked: 99, redirected: 99, focusSessions: 99 },
      invalid: { blocked: 99 }
    }
  }, now);

  assert.equal(STATISTICS_HISTORY_DAYS, 30);
  assert.deepEqual(Object.keys(stats.dailyHistory), ['2026-07-20', '2026-08-18']);
});

test('daily history counters increment independently', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0);
  let stats = normalizeStatistics({ lastResetDate: now.toDateString() }, now);
  stats = incrementDailyHistory(stats, 'blocked', now);
  stats = incrementDailyHistory(stats, 'redirected', now);
  stats = incrementDailyHistory(stats, 'focusSessions', now);

  assert.deepEqual(stats.dailyHistory[getLocalDateKey(now)], {
    blocked: 1,
    redirected: 1,
    focusSessions: 1
  });
});

test('chart series fills missing days with zeroes and keeps chronological order', () => {
  const now = new Date(2026, 7, 18, 12, 0, 0);
  const series = buildStatisticsSeries({
    lastResetDate: now.toDateString(),
    dailyHistory: {
      '2026-08-16': { blocked: 3, redirected: 1, focusSessions: 0 },
      '2026-08-18': { blocked: 5, redirected: 2, focusSessions: 1 }
    }
  }, 3, now);

  assert.deepEqual(series.map(day => day.dateKey), ['2026-08-16', '2026-08-17', '2026-08-18']);
  assert.deepEqual(series.map(day => day.blocked), [3, 0, 5]);
  assert.deepEqual(series.map(day => day.focusSessions), [0, 0, 1]);
});
