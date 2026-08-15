import test from 'node:test';
import assert from 'node:assert/strict';

import { createDailyLimitTracker } from '../rules/dailyLimitTracker.js';

function makeRule(overrides = {}) {
  return {
    id: 1,
    blockURL: 'youtube.com',
    category: 'entertainment',
    assignments: [{
      listId: 'general',
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 1 },
      schedule: null
    }],
    disabledByUser: false,
    isWhitelist: false,
    ...overrides
  };
}

function createTracker({
  tab = { id: 11, windowId: 7, active: true, url: 'https://youtube.com/watch?v=1' },
  windowFocused = true,
  recordSample,
  requestSync = async () => {},
  usageSeconds = {},
  tabsApiOverrides = {},
  windowsApiOverrides = {},
  rules = [makeRule()],
  ruleLists = [{ id: 'general', disabled: false }]
} = {}) {
  return createDailyLimitTracker({
    tabsApi: {
      async query(queryInfo) {
        assert.deepEqual(queryInfo, { active: true, lastFocusedWindow: true });
        return tab ? [tab] : [];
      },
      ...tabsApiOverrides
    },
    windowsApi: {
      WINDOW_ID_NONE: -1,
      async get(windowId) {
        assert.equal(windowId, 7);
        return { id: 7, focused: windowFocused };
      },
      ...windowsApiOverrides
    },
    getRules: async () => rules,
    getSettings: async () => ({ disabledCategories: [] }),
    getRuleLists: async () => ruleLists,
    getFocusSessionState: async () => ({ focusActive: false }),
    dailyLimitManager: {
      async getUsageSeconds() { return { ...usageSeconds }; },
      async recordSample(keys) {
        if (recordSample) return recordSample(keys);
        return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
      }
    },
    dnrSynchronizer: { requestSync },
    logger: { info() {}, log() {} }
  });
}

test('tracker uses the last-focused active tab and resolves assignment usage keys', async () => {
  let sampled = null;
  const tracker = createTracker({
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('test', new Date('2026-08-15T12:00:00.000Z'));
  assert.deepEqual(sampled, ['1:general']);
  assert.deepEqual(tracker.getDebugState(), {
    lastReason: 'test',
    lastSampleAt: '2026-08-15T12:00:00.000Z',
    resolution: 'matched',
    activeRuleId: 1,
    activeAssignmentListIds: ['general'],
    tabId: 11,
    windowId: 7,
    focusSource: 'windows_get',
    addedSeconds: 0,
    currentUsageSeconds: 0,
    errorName: null
  });
});

test('tracker does not count when the candidate browser window is not focused', async () => {
  let sampled = 'unset';
  const tracker = createTracker({
    windowFocused: false,
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('test');
  assert.deepEqual(sampled, []);
  assert.equal(tracker.getDebugState().resolution, 'browser_not_focused');
});

test('focus events override stale window focus queries', async () => {
  let sampled = 'unset';
  let windowGets = 0;
  const tracker = createTracker({
    windowsApiOverrides: {
      async get() {
        windowGets++;
        return { id: 7, focused: false };
      }
    },
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  tracker.noteWindowFocus(7);
  await tracker.sample('window_focus_changed');
  assert.deepEqual(sampled, ['1:general']);
  assert.equal(windowGets, 0);
  assert.equal(tracker.getDebugState().focusSource, 'focus_event');

  tracker.noteWindowFocus(-1);
  await tracker.sample('window_focus_changed');
  assert.equal(tracker.getDebugState().resolution, 'browser_not_focused');
});

test('direct tab hints avoid a second tabs.query race on activation and URL changes', async () => {
  let queryCalls = 0;
  let sampled = null;
  const tracker = createTracker({
    tabsApiOverrides: {
      async query() {
        queryCalls++;
        return [];
      }
    },
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample(
    'tab_activated',
    new Date(2026, 7, 15, 12, 0),
    { id: 11, windowId: 7, active: true, url: 'https://youtube.com/' }
  );

  assert.equal(queryCalls, 0);
  assert.deepEqual(sampled, ['1:general']);
});

test('tracker falls back from windows.get to getLastFocused when needed', async () => {
  let sampled = null;
  const tracker = createTracker({
    windowsApiOverrides: {
      async get() {
        throw new Error('get unavailable');
      },
      async getLastFocused() {
        return { id: 7, focused: true };
      }
    },
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('test');
  assert.deepEqual(sampled, ['1:general']);
  assert.equal(tracker.getDebugState().focusSource, 'windows_get_last_focused');
});

test('multiple active Daily Limit assignments are sampled together', async () => {
  let sampled = null;
  const tracker = createTracker({
    rules: [makeRule({
      assignments: [
        { listId: 'work', blockingMode: 'daily_limit', dailyLimit: { minutes: 10 }, schedule: null },
        { listId: 'study', blockingMode: 'daily_limit', dailyLimit: { minutes: 20 }, schedule: null }
      ]
    })],
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    },
    ruleLists: [{ id: 'general', disabled: false }, { id: 'work', disabled: false }, { id: 'study', disabled: false }]
  });
  // Both custom lists must exist and be enabled for the test.
  tracker.noteWindowFocus(7);
  // Override getRuleLists by reconstructing tracker is unnecessary in product;
  // legacy General fallback would otherwise normalize unknown list state only in mutations.
  await tracker.sample('test');
  assert.deepEqual(sampled.sort(), ['1:study', '1:work']);
});

test('crossing a Daily Limit assignment triggers DNR synchronization', async () => {
  let syncs = 0;
  const tracker = createTracker({
    recordSample() {
      return {
        accountedAssignmentKeys: ['1:general'],
        addedSeconds: 2,
        usageUpdates: {
          '1:general': { previousUsageSeconds: 59, currentUsageSeconds: 61 }
        }
      };
    },
    async requestSync() {
      syncs++;
    }
  });

  await tracker.sample();
  assert.equal(syncs, 1);
});
