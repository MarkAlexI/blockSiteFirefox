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

function createExistingStatistics() {
  const now = new Date();
  const today = getLocalDateKey(now);
  return {
    totalBlocked: 41,
    blockedToday: 4,
    totalRedirects: 8,
    redirectsToday: 2,
    successfulFocusSessions: 3,
    creationDate: '2026-01-01',
    lastResetDate: now.toDateString(),
    dailyHistory: {
      [today]: { blocked: 4, redirected: 2, focusSessions: 1 }
    }
  };
}

async function withoutExpectedStorageErrors(callback) {
  const previousError = console.error;
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.error = previousError;
  }
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

for (const [eventName, recordEvent] of [
  ['blocked-page', manager => manager.recordBlock('https://blocked.example/')],
  ['redirect', manager => manager.recordRedirect('from', 'to')],
  ['completed-focus', manager => manager.recordFocusSession()]
]) {
  test(eventName + ' statistics never overwrite saved counters after a failed read', async () => {
    const original = createExistingStatistics();
    await withStatistics({ statistics: original }, async ({ api, StatisticsManager }) => {
      const writes = [];
      const originalSet = api.storage.local.set.bind(api.storage.local);
      api.storage.local.set = (values, callback) => {
        writes.push(structuredClone(values));
        return originalSet(values, callback);
      };
      api.storage.local.getError = new Error('statistics temporarily unavailable');

      await withoutExpectedStorageErrors(async () => {
        await assert.doesNotReject(recordEvent(StatisticsManager));
      });

      assert.deepEqual(writes, []);
      assert.deepEqual(api.storage.local.data.statistics, original);
    });
  });
}

test('statistics display keeps its safe fallback without modifying an unreadable saved history', async () => {
  const original = createExistingStatistics();
  await withStatistics({ statistics: original }, async ({ api, StatisticsManager }) => {
    api.storage.local.getError = new Error('statistics temporarily unavailable');

    await withoutExpectedStorageErrors(async () => {
      const display = await StatisticsManager.getStatistics();
      assert.equal(display.totalBlocked, 0);
      assert.equal(display.totalRedirects, 0);
    });

    assert.deepEqual(api.storage.local.data.statistics, original);
  });
});

test('strict statistics reads expose storage errors instead of fabricating a writable empty snapshot', async () => {
  const original = createExistingStatistics();
  await withStatistics({ statistics: original }, async ({ api, StatisticsManager }) => {
    api.storage.local.getError = new Error('statistics temporarily unavailable');

    await withoutExpectedStorageErrors(async () => {
      await assert.rejects(
        StatisticsManager.readStatistics({ throwOnError: true }),
        /statistics temporarily unavailable/
      );
    });

    assert.deepEqual(api.storage.local.data.statistics, original);
  });
});

test('a failed statistics mutation does not poison later queued events or erase existing history', async () => {
  const original = createExistingStatistics();
  const today = getLocalDateKey(new Date());
  await withStatistics({ statistics: original }, async ({ api, StatisticsManager }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let failed = false;
    api.storage.local.get = (keys, callback) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('temporary statistics read failure'));
      }
      return originalGet(keys, callback);
    };

    await withoutExpectedStorageErrors(async () => {
      await Promise.all([
        StatisticsManager.recordBlock('first-block-is-skipped'),
        StatisticsManager.recordRedirect('from', 'to'),
        StatisticsManager.recordFocusSession()
      ]);
    });

    assert.equal(api.storage.local.data.statistics.totalBlocked, 41);
    assert.equal(api.storage.local.data.statistics.totalRedirects, 9);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 4);
    assert.deepEqual(api.storage.local.data.statistics.dailyHistory[today], {
      blocked: 4,
      redirected: 3,
      focusSessions: 2
    });

    await StatisticsManager.recordBlock('later-block-is-preserved');
    assert.equal(api.storage.local.data.statistics.totalBlocked, 42);
    assert.equal(api.storage.local.data.statistics.dailyHistory[today].blocked, 5);
  });
});

test('statistics reset never erases saved history when its original snapshot cannot be read', async () => {
  const original = createExistingStatistics();
  await withStatistics({ statistics: original }, async ({ api, StatisticsManager }) => {
    const writes = [];
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => {
      writes.push(structuredClone(values));
      return originalSet(values, callback);
    };
    api.storage.local.getError = new Error('statistics temporarily unavailable');

    await withoutExpectedStorageErrors(async () => {
      await assert.doesNotReject(StatisticsManager.reset());
    });

    assert.deepEqual(writes, []);
    assert.deepEqual(api.storage.local.data.statistics, original);
  });
});

test('a failed legacy-statistics normalization never replaces the original counters', async () => {
  const original = { totalBlocked: 41, totalRedirects: 8, successfulFocusSessions: 3 };
  await withStatistics({ statistics: original }, async ({ api, StatisticsManager }) => {
    api.storage.local.setError = new Error('statistics normalization write failed');

    await withoutExpectedStorageErrors(async () => {
      await assert.doesNotReject(StatisticsManager.recordBlock('blocked.example'));
    });

    assert.deepEqual(api.storage.local.data.statistics, original);

    api.storage.local.setError = null;
    await StatisticsManager.recordBlock('recovered.example');
    assert.equal(api.storage.local.data.statistics.totalBlocked, 42);
    assert.equal(api.storage.local.data.statistics.totalRedirects, 8);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 3);
  });
});

test('a failed first statistics initialization leaves no fabricated history and later recovers', async () => {
  await withStatistics({}, async ({ api, StatisticsManager }) => {
    api.storage.local.setError = new Error('statistics initialization write failed');

    await withoutExpectedStorageErrors(async () => {
      await assert.doesNotReject(StatisticsManager.recordBlock('first-block'));
    });

    assert.equal('statistics' in api.storage.local.data, false);

    api.storage.local.setError = null;
    await StatisticsManager.recordBlock('recovered-block');
    assert.equal(api.storage.local.data.statistics.totalBlocked, 1);
    assert.equal(api.storage.local.data.statistics.blockedToday, 1);
  });
});

test('failed statistics update and reset writes keep existing counters and creation date intact', async () => {
  const original = createExistingStatistics();
  await withStatistics({ statistics: original }, async ({ api, StatisticsManager }) => {
    api.storage.local.setError = new Error('statistics write rejected');

    await withoutExpectedStorageErrors(async () => {
      await assert.doesNotReject(StatisticsManager.recordRedirect('from', 'to'));
      await assert.doesNotReject(StatisticsManager.reset());
    });

    assert.deepEqual(api.storage.local.data.statistics, original);

    api.storage.local.setError = null;
    await StatisticsManager.recordRedirect('from', 'to');
    assert.equal(api.storage.local.data.statistics.totalRedirects, 9);
    assert.equal(api.storage.local.data.statistics.creationDate, '2026-01-01');
  });
});
