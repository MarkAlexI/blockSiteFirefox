import test from 'node:test';
import assert from 'node:assert/strict';

import { getLocalDateKey } from '../pro/statisticsHistory.js';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

async function withStatistics(local, callback) {
  const api = createExtensionApi({ local });
  await withExtensionEnvironment(api, async () => {
    const { StatisticsManager } = await import('../pro/statisticsManager.js');
    await callback({ api, StatisticsManager });
  });
}

test('missing statistics are initialized once with safe default counters', async () => {
  await withStatistics({}, async ({ api, StatisticsManager }) => {
    const statistics = await StatisticsManager.getStatistics();
    assert.equal(statistics.totalBlocked, 0);
    assert.equal(statistics.totalRedirects, 0);
    assert.equal(statistics.successfulFocusSessions, 0);
    assert.deepEqual(api.storage.local.data.statistics, statistics);
  });
});

test('legacy statistics are normalized and written back without preserving invalid counters', async () => {
  await withStatistics({ statistics: { totalBlocked: -5, totalRedirects: '3' } }, async ({
    api, StatisticsManager
  }) => {
    const statistics = await StatisticsManager.getStatistics();
    assert.equal(statistics.totalBlocked, 0);
    assert.equal(statistics.totalRedirects, 3);
    assert.equal(typeof statistics.creationDate, 'string');
    assert.deepEqual(api.storage.local.data.statistics, statistics);
  });
});

test('block, redirect, and completed focus events update both totals and the local-day history', async () => {
  await withStatistics({}, async ({ api, StatisticsManager }) => {
    await StatisticsManager.recordBlock('https://blocked.example/');
    await StatisticsManager.recordRedirect('https://blocked.example/', 'https://safe.example/');
    await StatisticsManager.recordFocusSession();
    const today = getLocalDateKey(new Date());
    assert.equal(api.storage.local.data.statistics.totalBlocked, 1);
    assert.equal(api.storage.local.data.statistics.blockedToday, 1);
    assert.equal(api.storage.local.data.statistics.totalRedirects, 1);
    assert.equal(api.storage.local.data.statistics.redirectsToday, 1);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.deepEqual(api.storage.local.data.statistics.dailyHistory[today], {
      blocked: 1,
      redirected: 1,
      focusSessions: 1
    });
  });
});

test('concurrent blocked-page events never lose statistics increments', async () => {
  await withStatistics({}, async ({ api, StatisticsManager }) => {
    await Promise.all(Array.from({ length: 25 }, (_, index) =>
      StatisticsManager.recordBlock('https://blocked.example/' + index)
    ));

    const today = getLocalDateKey(new Date());
    assert.equal(api.storage.local.data.statistics.totalBlocked, 25);
    assert.equal(api.storage.local.data.statistics.blockedToday, 25);
    assert.equal(api.storage.local.data.statistics.dailyHistory[today].blocked, 25);
  });
});

test('concurrent mixed statistics events preserve every event type', async () => {
  await withStatistics({}, async ({ api, StatisticsManager }) => {
    await Promise.all([
      ...Array.from({ length: 12 }, () => StatisticsManager.recordBlock('blocked')),
      ...Array.from({ length: 9 }, () => StatisticsManager.recordRedirect('from', 'to')),
      ...Array.from({ length: 4 }, () => StatisticsManager.recordFocusSession())
    ]);

    const today = getLocalDateKey(new Date());
    assert.equal(api.storage.local.data.statistics.totalBlocked, 12);
    assert.equal(api.storage.local.data.statistics.totalRedirects, 9);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 4);
    assert.deepEqual(api.storage.local.data.statistics.dailyHistory[today], {
      blocked: 12,
      redirected: 9,
      focusSessions: 4
    });
  });
});

test('statistics reset is ordered between concurrent updates', async () => {
  await withStatistics({}, async ({ api, StatisticsManager }) => {
    await Promise.all([
      StatisticsManager.recordBlock('before-reset'),
      StatisticsManager.reset(),
      StatisticsManager.recordBlock('after-reset')
    ]);

    assert.equal(api.storage.local.data.statistics.totalBlocked, 1);
    assert.equal(api.storage.local.data.statistics.blockedToday, 1);
  });
});

test('statistics reset preserves the original creation date and clears all counters', async () => {
  await withStatistics({ statistics: {
    totalBlocked: 8,
    totalRedirects: 3,
    successfulFocusSessions: 2,
    creationDate: '2026-01-01',
    lastResetDate: new Date().toDateString()
  } }, async ({ api, StatisticsManager }) => {
    await StatisticsManager.reset();
    assert.equal(api.storage.local.data.statistics.creationDate, '2026-01-01');
    assert.equal(api.storage.local.data.statistics.totalBlocked, 0);
    assert.equal(api.storage.local.data.statistics.totalRedirects, 0);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 0);
  });
});

test('statistics reads and writes fail safely without escaping background event handlers', async () => {
  await withStatistics({ statistics: { totalBlocked: 2 } }, async ({ api, StatisticsManager }) => {
    const previousError = console.error;
    console.error = () => {};
    try {
      api.storage.local.getError = new Error('statistics unavailable');
      assert.equal((await StatisticsManager.getStatistics()).totalBlocked, 0);
      await assert.doesNotReject(StatisticsManager.recordBlock('https://blocked.example/'));

      api.storage.local.getError = null;
      api.storage.local.setError = new Error('statistics storage read-only');
      await assert.doesNotReject(StatisticsManager.recordRedirect('from', 'to'));
      await assert.doesNotReject(StatisticsManager.reset());
    } finally {
      console.error = previousError;
    }
  });
});
