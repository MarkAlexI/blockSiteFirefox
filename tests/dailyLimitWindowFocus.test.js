import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyLimitTracker } from '../rules/dailyLimitTracker.js';
import { DailyLimitManager } from '../rules/dailyLimitManager.js';

function fixture({ mobile = false, documentHasFocus = true } = {}) {
  const start = new Date(2026, 10, 14, 12).getTime();
  let clock = start, focused = true, focusError = null, probeHook = () => {};
  const data = {}, alarms = new Map();
  const manager = new DailyLimitManager({
    async get() { return structuredClone(data); },
    async set(values) { Object.assign(data, structuredClone(values)); }
  });
  const tab = { id: 11, windowId: 7, active: true, url: 'https://tracked.example/start' };
  const tracker = createDailyLimitTracker({
    tabsApi: { async query() { return [structuredClone(tab)]; } },
    windowsApi: mobile ? undefined : {
      async get(id) {
        assert.equal(id, tab.windowId);
        if (focusError) throw focusError;
        return { id, focused };
      }
    },
    scriptingApi: { async executeScript() {
      await probeHook();
      return [{ result: { visibilityState: 'visible', hidden: false, hasFocus: documentHasFocus } }];
    } },
    alarmsApi: {
      async create(name, value) { alarms.set(name, value); },
      async clear(name) { return alarms.delete(name); }
    },
    getRules: async () => [{ id: 1, blockURL: 'tracked.example', category: 'social',
      assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'daily_limit',
        schedule: null, dailyLimit: { minutes: 10 } }], isWhitelist: false }],
    getRuleListState: async () => ({ activeRuleListId: 'general', lists: [{ id: 'general' }] }),
    getFocusSessionState: async () => ({ focusActive: false }),
    dailyLimitManager: manager, dnrSynchronizer: { async requestSync() {} },
    getNow: () => new Date(clock), logger: { info() {}, log() {} }
  });
  return {
    data, tracker, alarms, tab,
    at(seconds) { clock = start + seconds * 1000; },
    focus(value) { focused = value; },
    failFocus(error) { focusError = error; },
    onProbe(hook) { probeHook = hook; },
    sample(reason = 'minute_alarm') { return tracker.sample(reason, new Date(clock), { ...tab }); },
    pause() { return tracker.pause('window_focus_lost', new Date(clock)); },
    visible() { return tracker.visibilityChanged({ tabId: tab.id, url: tab.url,
      visibilityState: 'visible', observedAt: clock }); },
    async usage() { return (await manager.getUsageSeconds(new Date(clock)))['1:general'] || 0; }
  };
}

for (const documentHasFocus of [false, true]) {
  for (const reason of ['tab_url_changed', 'tab_load_complete', 'tab_created', 'tab_activated',
    'minute_alarm', 'deadline_alarm']) {
    test(`an unfocused window cannot resume ${reason}, even with document.hasFocus=${documentHasFocus}`, async () => {
      const f = fixture({ documentHasFocus });
      await f.sample();
      f.at(10);f.focus(false);await f.pause();
      assert.equal(await f.usage(), 10);
      for (const seconds of [20, 30]) { f.at(seconds);await f.sample(reason); }
      assert.equal(await f.usage(), 10, 'background samples preserve the spent budget');
      assert.deepEqual(f.data.dailyRuleUsage.lastSample.assignmentKeys, []);
      assert.equal(f.alarms.has('daily_limit_deadline'), false);
      assert.equal(f.tracker.getDebugState().resolution, 'window_unfocused');

      f.at(40);f.focus(true);await f.sample('window_focus_gained');
      f.at(50);await f.sample();
      assert.equal(await f.usage(), 20, 'returning to Firefox resumes genuine foreground time');
      assert.equal(f.alarms.has('daily_limit_deadline'), true);
    });
  }
}

test('a missed focus-loss event drops an uncertain segment without charging the background gap', async () => {
  const f = fixture();await f.sample();
  f.at(10);await f.sample();
  f.at(40);f.focus(false);await f.sample('tab_url_changed');
  assert.equal(await f.usage(), 10);
  assert.deepEqual(f.data.dailyRuleUsage.lastSample.assignmentKeys, []);
  f.at(60);f.focus(true);await f.sample('window_focus_gained');
  f.at(70);await f.sample();
  assert.equal(await f.usage(), 20);
});

test('a window disappearing or a failed focus read does not spend or restart the budget', async () => {
  const f = fixture();await f.sample();
  f.at(10);await f.sample();
  f.at(40);f.failFocus(new Error('Window not found'));await f.sample('tab_url_changed');
  assert.equal(await f.usage(), 10);
  assert.deepEqual(f.data.dailyRuleUsage.lastSample.assignmentKeys, []);
  assert.equal(f.alarms.has('daily_limit_deadline'), false);
  assert.equal(f.tracker.getDebugState().resolution, 'window_focus_unavailable');
  f.at(60);f.failFocus(null);await f.sample();
  f.at(70);await f.sample();
  assert.equal(await f.usage(), 20);
});

test('focus is verified after an asynchronous visibility probe, before resuming a segment', async () => {
  const f = fixture();await f.sample();
  f.at(10);await f.pause();
  f.onProbe(() => f.focus(false));
  f.at(30);await f.sample('tab_url_changed');
  assert.equal(await f.usage(), 10);
  assert.deepEqual(f.data.dailyRuleUsage.lastSample.assignmentKeys, []);
});

test('a visible content event cannot restart Daily Limits while Firefox lacks window focus', async () => {
  const f = fixture();await f.sample();
  f.at(10);f.focus(false);await f.pause();
  f.at(30);await f.visible();
  f.at(40);await f.sample();
  assert.equal(await f.usage(), 10);
  assert.deepEqual(f.data.dailyRuleUsage.lastSample.assignmentKeys, []);
});

test('windowless Android keeps page-visibility accounting without requiring document focus', async () => {
  const f = fixture({ mobile: true, documentHasFocus: false });
  await f.sample();f.at(10);await f.sample();
  assert.equal(await f.usage(), 10);
  assert.deepEqual(f.data.dailyRuleUsage.lastSample.assignmentKeys, ['1:general']);
});
