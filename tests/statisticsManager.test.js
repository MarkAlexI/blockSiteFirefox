import test from 'node:test';
import assert from 'node:assert/strict';

import { getLocalDateKey } from '../pro/statisticsHistory.js';

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(key => [key, data[key]]));
      }
      return { [keys]: data[keys] };
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    }
  };
}

function createExtensionApi(localStorage) {
  return {
    storage: {
      local: localStorage,
      sync: {
        get(_keys, callback) {
          const result = { settings: { debugMode: false } };
          if (typeof callback === 'function') callback(result);
          return Promise.resolve(result);
        },
        set() {
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener() {}
      }
    }
  };
}

test('StatisticsManager records each event once in totals, today counters, and daily history', async () => {
  const storage = createStorage();
  globalThis.browser = createExtensionApi(storage);
  const { StatisticsManager } = await import('../pro/statisticsManager.js');

  await StatisticsManager.recordBlock('https://example.test/');
  await StatisticsManager.recordRedirect('https://example.test/', 'https://example.org/');
  await StatisticsManager.recordFocusSession();

  const stats = storage.data.statistics;
  const today = getLocalDateKey(new Date());
  assert.equal(stats.totalBlocked, 1);
  assert.equal(stats.blockedToday, 1);
  assert.equal(stats.totalRedirects, 1);
  assert.equal(stats.redirectsToday, 1);
  assert.equal(stats.successfulFocusSessions, 1);
  assert.deepEqual(stats.dailyHistory[today], {
    blocked: 1,
    redirected: 1,
    focusSessions: 1
  });

  delete globalThis.browser;
});

test('StatisticsManager reset clears history while preserving the original creation date', async () => {
  const creationDate = 'Mon Aug 10 2026';
  const storage = createStorage({
    statistics: {
      totalBlocked: 10,
      blockedToday: 2,
      totalRedirects: 3,
      redirectsToday: 1,
      successfulFocusSessions: 4,
      creationDate,
      lastResetDate: new Date().toDateString(),
      dailyHistory: {
        [getLocalDateKey(new Date())]: { blocked: 2, redirected: 1, focusSessions: 1 }
      }
    }
  });
  globalThis.browser = createExtensionApi(storage);
  const { StatisticsManager } = await import('../pro/statisticsManager.js');

  await StatisticsManager.reset();

  assert.equal(storage.data.statistics.creationDate, creationDate);
  assert.equal(storage.data.statistics.totalBlocked, 0);
  assert.deepEqual(storage.data.statistics.dailyHistory, {});

  delete globalThis.browser;
});
