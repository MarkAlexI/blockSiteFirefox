import test from 'node:test';
import assert from 'node:assert/strict';

import { createDailyLimitTracker } from '../rules/dailyLimitTracker.js';

function makeRule(overrides = {}) {
  return {
    id: 1,
    blockURL: 'youtube.com',
    category: 'entertainment',
    listId: 'general',
    blockingMode: 'daily_limit',
    dailyLimit: { minutes: 1 },
    schedule: null,
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
  tabsApiOverrides = {},
  windowsApiOverrides = {}
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
    getRules: async () => [makeRule()],
    getSettings: async () => ({ disabledCategories: [] }),
    getRuleLists: async () => [{ id: 'general', disabled: false }],
    getFocusSessionState: async () => ({ focusActive: false }),
    dailyLimitManager: {
      async recordSample(ruleId) {
        if (recordSample) return recordSample(ruleId);
        return { accountedRuleId: null, addedSeconds: 0, currentUsageSeconds: 0 };
      }
    },
    dnrSynchronizer: { requestSync },
    logger: {}
  });
}

test('tracker uses the last-focused active tab and confirms its window is focused', async () => {
  let sampled = null;
  const tracker = createTracker({
    recordSample(ruleId) {
      sampled = ruleId;
      return { accountedRuleId: null, addedSeconds: 0, currentUsageSeconds: 0 };
    }
  });

  await tracker.sample('test', new Date(2026, 7, 15, 12, 0));
  assert.equal(sampled, 1);
  assert.deepEqual(tracker.getDebugState(), {
    lastReason: 'test',
    lastSampleAt: '2026-08-15T12:00:00.000Z',
    resolution: 'matched',
    activeRuleId: 1,
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
    recordSample(ruleId) {
      sampled = ruleId;
      return { accountedRuleId: null, addedSeconds: 0, currentUsageSeconds: 0 };
    }
  });

  await tracker.sample('test');
  assert.equal(sampled, null);
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
    recordSample(ruleId) {
      sampled = ruleId;
      return { accountedRuleId: null, addedSeconds: 0, currentUsageSeconds: 0 };
    }
  });

  tracker.noteWindowFocus(7);
  await tracker.sample('window_focus_changed');
  assert.equal(sampled, 1);
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
    recordSample(ruleId) {
      sampled = ruleId;
      return { accountedRuleId: null, addedSeconds: 0, currentUsageSeconds: 0 };
    }
  });

  await tracker.sample(
    'tab_activated',
    new Date(2026, 7, 15, 12, 0),
    { id: 11, windowId: 7, active: true, url: 'https://youtube.com/' }
  );

  assert.equal(queryCalls, 0);
  assert.equal(sampled, 1);
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
    recordSample(ruleId) {
      sampled = ruleId;
      return { accountedRuleId: null, addedSeconds: 0, currentUsageSeconds: 0 };
    }
  });

  await tracker.sample('test');
  assert.equal(sampled, 1);
  assert.equal(tracker.getDebugState().focusSource, 'windows_get_last_focused');
});

test('crossing a daily limit triggers DNR synchronization', async () => {
  let syncs = 0;
  const tracker = createTracker({
    recordSample() {
      return {
        accountedRuleId: 1,
        addedSeconds: 2,
        previousUsageSeconds: 59,
        currentUsageSeconds: 61
      };
    },
    async requestSync() {
      syncs++;
    }
  });

  await tracker.sample();
  assert.equal(syncs, 1);
});
