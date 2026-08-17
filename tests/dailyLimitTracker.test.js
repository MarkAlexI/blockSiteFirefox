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
      disabledByUser: false,
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 1 },
      schedule: null
    }],
    isWhitelist: false,
    ...overrides
  };
}

function createTracker({
  tab = { id: 11, windowId: 7, active: true, url: 'https://youtube.com/watch?v=1' },
  visibilityState = 'visible',
  documentHasFocus = true,
  recordSample,
  requestSync = async () => {},
  usageSeconds = {},
  tabsApiOverrides = {},
  scriptingApiOverrides = {},
  rules = [makeRule()],
  ruleLists = [{ id: 'general', name: 'General', disabledCategories: [] }],
  activeRuleListId = 'general'
} = {}) {
  return createDailyLimitTracker({
    tabsApi: {
      async query(queryInfo) {
        assert.deepEqual(queryInfo, { active: true, lastFocusedWindow: true });
        return tab ? [tab] : [];
      },
      ...tabsApiOverrides
    },
    scriptingApi: {
      async executeScript(details) {
        assert.deepEqual(details.target, { tabId: 11 });
        assert.equal(typeof details.func, 'function');
        return [{
          frameId: 0,
          result: {
            visibilityState,
            hidden: visibilityState !== 'visible',
            hasFocus: documentHasFocus
          }
        }];
      },
      ...scriptingApiOverrides
    },
    getRules: async () => rules,
    getRuleListState: async () => ({ lists: ruleLists, activeRuleListId }),
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

test('tracker counts a matching Daily Limit assignment only when the page is visible', async () => {
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
    visibilityState: 'visible',
    visibilitySource: 'document_visibility',
    documentHasFocus: true,
    addedSeconds: 0,
    currentUsageSeconds: 0,
    errorName: null
  });
});

test('hidden pages reset the sample instead of charging background time', async () => {
  let sampled = 'unset';
  const tracker = createTracker({
    visibilityState: 'hidden',
    documentHasFocus: false,
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('minute_alarm');
  assert.deepEqual(sampled, []);
  assert.equal(tracker.getDebugState().resolution, 'page_hidden');
  assert.equal(tracker.getDebugState().visibilityState, 'hidden');
  assert.equal(tracker.getDebugState().documentHasFocus, false);
});

test('visibility probe failures fail safe without charging usage', async () => {
  let sampled = 'unset';
  const tracker = createTracker({
    scriptingApiOverrides: {
      async executeScript() {
        const error = new Error('Cannot access contents of the page');
        error.name = 'PermissionError';
        throw error;
      }
    },
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('minute_alarm');
  assert.deepEqual(sampled, []);
  assert.equal(tracker.getDebugState().resolution, 'visibility_probe_failed');
  assert.equal(tracker.getDebugState().visibilitySource, 'scripting_execute_script');
  assert.equal(tracker.getDebugState().errorName, 'PermissionError');
});

test('missing scripting API fails safe and is visible in diagnostics', async () => {
  let sampled = 'unset';
  const tracker = createTracker({
    scriptingApiOverrides: { executeScript: undefined },
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('minute_alarm');
  assert.deepEqual(sampled, []);
  assert.equal(tracker.getDebugState().resolution, 'visibility_probe_unavailable');
  assert.equal(tracker.getDebugState().visibilitySource, 'scripting_unavailable');
});

test('non-matching tabs do not trigger a page visibility injection', async () => {
  let injections = 0;
  let sampled = 'unset';
  const tracker = createTracker({
    tab: { id: 11, windowId: 7, active: true, url: 'https://example.com/' },
    scriptingApiOverrides: {
      async executeScript() {
        injections++;
        return [];
      }
    },
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('minute_alarm');
  assert.equal(injections, 0);
  assert.deepEqual(sampled, []);
  assert.equal(tracker.getDebugState().resolution, 'no_matching_rule');
});

test('partial DNR-style targets such as yout match m.youtube.com for Daily Limit tracking', async () => {
  let sampled = null;
  const tracker = createTracker({
    tab: { id: 11, windowId: 7, active: true, url: 'https://m.youtube.com/watch?v=1' },
    rules: [makeRule({ blockURL: 'yout' })],
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('minute_alarm');
  assert.deepEqual(sampled, ['1:general']);
  assert.equal(tracker.getDebugState().resolution, 'matched');
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

test('only the active profile Daily Limit assignment is sampled', async () => {
  let sampled = null;
  const tracker = createTracker({
    rules: [makeRule({
      assignments: [
        { listId: 'work', blockingMode: 'daily_limit', dailyLimit: { minutes: 10 }, schedule: null },
        { listId: 'study', blockingMode: 'daily_limit', dailyLimit: { minutes: 20 }, schedule: null }
      ]
    })],
    activeRuleListId: 'study',
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    },
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'work', name: 'Work', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ]
  });

  await tracker.sample('test');
  assert.deepEqual(sampled, ['1:study']);
});

test('disabled General assignment does not hide an enabled Study Daily Limit target', async () => {
  let sampled = null;
  const tracker = createTracker({
    tab: { id: 11, windowId: 7, active: true, url: 'https://m.youtube.com/watch?v=1' },
    rules: [makeRule({
      blockURL: 'yout',
      assignments: [
        { listId: 'general', disabledByUser: true, blockingMode: 'always', schedule: null, dailyLimit: null },
        { listId: 'study', disabledByUser: false, blockingMode: 'daily_limit', dailyLimit: { minutes: 20 }, schedule: null }
      ]
    })],
    activeRuleListId: 'study',
    ruleLists: [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'study', name: 'Study', disabledCategories: [] }
    ],
    recordSample(keys) {
      sampled = keys;
      return { accountedAssignmentKeys: [], addedSeconds: 0, usageUpdates: {} };
    }
  });

  await tracker.sample('test');
  assert.deepEqual(sampled, ['1:study']);
  assert.equal(tracker.getDebugState().resolution, 'matched');
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
