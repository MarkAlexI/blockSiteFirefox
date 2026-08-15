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

test('tracker samples only a matching tab in a focused browser window', async () => {
  let sampled = null;
  const tracker = createDailyLimitTracker({
    tabsApi: {},
    windowsApi: {
      async getLastFocused() {
        return { focused: true, tabs: [{ active: true, url: 'https://youtube.com/watch?v=1' }] };
      }
    },
    getRules: async () => [makeRule()],
    getSettings: async () => ({ disabledCategories: [] }),
    getRuleLists: async () => [{ id: 'general', disabled: false }],
    getFocusSessionState: async () => ({ focusActive: false }),
    dailyLimitManager: {
      async recordSample(ruleId) {
        sampled = ruleId;
        return { accountedRuleId: null, addedSeconds: 0 };
      }
    },
    dnrSynchronizer: { requestSync: async () => {} },
    logger: {}
  });

  await tracker.sample('test', new Date(2026, 7, 15, 12, 0));
  assert.equal(sampled, 1);
});

test('tracker does not count when the browser window is not focused', async () => {
  let sampled = 'unset';
  const tracker = createDailyLimitTracker({
    tabsApi: {},
    windowsApi: { async getLastFocused() { return { focused: false, tabs: [] }; } },
    getRules: async () => [makeRule()],
    getSettings: async () => ({ disabledCategories: [] }),
    getRuleLists: async () => [{ id: 'general', disabled: false }],
    getFocusSessionState: async () => ({ focusActive: false }),
    dailyLimitManager: {
      async recordSample(ruleId) {
        sampled = ruleId;
        return { accountedRuleId: null, addedSeconds: 0 };
      }
    },
    dnrSynchronizer: { requestSync: async () => {} },
    logger: {}
  });
  await tracker.sample();
  assert.equal(sampled, null);
});

test('crossing a daily limit triggers DNR synchronization', async () => {
  let syncs = 0;
  const rule = makeRule();
  const tracker = createDailyLimitTracker({
    tabsApi: {},
    windowsApi: { async getLastFocused() { return { focused: true, tabs: [{ active: true, url: 'https://youtube.com/' }] }; } },
    getRules: async () => [rule],
    getSettings: async () => ({ disabledCategories: [] }),
    getRuleLists: async () => [{ id: 'general', disabled: false }],
    getFocusSessionState: async () => ({ focusActive: false }),
    dailyLimitManager: {
      async recordSample() {
        return {
          accountedRuleId: 1,
          addedSeconds: 2,
          previousUsageSeconds: 59,
          currentUsageSeconds: 61
        };
      }
    },
    dnrSynchronizer: { async requestSync() { syncs++; } },
    logger: {}
  });
  await tracker.sample();
  assert.equal(syncs, 1);
});
