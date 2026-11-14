import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyLimitTracker } from '../rules/dailyLimitTracker.js';
import { DailyLimitManager } from '../rules/dailyLimitManager.js';

function fixture({ mobile = false, documentHasFocus = true,
  requiresWindowFocus = () => true, sessionStorage } = {}) {
  const start = new Date(2026, 10, 14, 12).getTime();
  let clock = start, focused = true, focusError = null, probeHook = () => {}, visibility = 'visible';
  const data = {}, alarms = new Map();
  const manager = new DailyLimitManager({
    async get() { return structuredClone(data); },
    async set(values) { Object.assign(data, structuredClone(values)); }
  });
  const tab = { id: 11, windowId: 7, active: true, url: 'https://tracked.example/start' };
  const tracker = createDailyLimitTracker({
    requiresWindowFocus, sessionStorage,
    tabsApi: {
      async query() { return [structuredClone(tab)]; },
      async get(id) { assert.equal(id, tab.id);return structuredClone(tab); }
    },
    windowsApi: mobile ? undefined : {
      async get(id) {
        assert.equal(id, tab.windowId);
        if (focusError) throw focusError;
        return { id, focused };
      }
    },
    scriptingApi: { async executeScript() {
      await probeHook();
      return [{ result: { visibilityState: visibility, hidden: visibility === 'hidden', hasFocus: documentHasFocus } }];
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
    visibility(value) {
      visibility = value;
      return tracker.visibilityChanged({ tabId: tab.id, url: tab.url, visibilityState: value, observedAt: clock });
    },
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

for (const broken of ['unfocused', 'unavailable']) {
  test(`Android counts a visible active page with an existing but ${broken} Windows API`, async () => {
    const f = fixture({ requiresWindowFocus: async () => false, documentHasFocus: false });
    f.focus(false);
    if (broken === 'unavailable') f.failFocus(new Error('Window not found'));
    await f.sample();f.at(30);await f.sample();f.at(60);await f.sample();
    assert.equal(await f.usage(), 60);
    assert.deepEqual(f.data.dailyRuleUsage.lastSample.assignmentKeys, ['1:general']);
    assert.equal(f.alarms.has('daily_limit_deadline'), true);
  });
}

test('Android hides, resumes and expires using page visibility even when native window focus stays false', async () => {
  const f = fixture({ requiresWindowFocus: async () => false, documentHasFocus: false });
  f.focus(false);await f.sample();f.at(30);await f.visibility('hidden');
  assert.equal(await f.usage(), 30);
  assert.deepEqual(f.data.dailyRuleUsage.lastSample.assignmentKeys, []);
  assert.equal(f.alarms.has('daily_limit_deadline'), false);
  f.at(70);await f.visibility('visible');f.at(100);await f.sample();
  assert.equal(await f.usage(), 60, 'hidden time is excluded, visible time resumes');
  for (let seconds = 160; seconds <= 640; seconds += 60) { f.at(seconds);await f.sample('deadline_alarm'); }
  assert.equal(await f.usage(), 600, 'the visible page eventually exhausts its real budget');
  assert.equal(f.alarms.has('daily_limit_deadline'), false);
});

test('the last visible rejection survives opening Options, a pause and a worker restart', async () => {
  const session = {};
  const sessionStorage = {
    async get(key) { return { [key]: structuredClone(session[key]) }; },
    async set(values) { Object.assign(session, structuredClone(values)); }
  };
  const f = fixture({ sessionStorage });f.focus(false);await f.sample();
  f.at(10);await f.visibility('hidden');await f.pause();
  const last = await f.tracker.getLastVisibleSample();
  assert.equal(last.resolution, 'window_unfocused');
  assert.equal(last.windowFocusRequired, true);
  assert.equal(last.windowFocused, false);
  assert.equal(last.activeRuleId, 1);
  assert.equal(last.currentUsageSeconds, 0);
  assert.equal(f.tracker.getDebugState().resolution, 'paused');
  const restarted = fixture({ sessionStorage });
  assert.deepEqual(await restarted.tracker.getLastVisibleSample(), last);
  assert.equal(JSON.stringify(last).includes('tracked.example'), false);
});

test('a hidden sample retains the last visible Android accounting result in diagnostic text', async () => {
  const f = fixture({ requiresWindowFocus: async () => false });f.focus(false);
  await f.sample();f.at(30);await f.sample();f.at(40);await f.visibility('hidden');
  const last = await f.tracker.getLastVisibleSample();
  assert.equal(last.resolution, 'matched');
  assert.equal(last.windowFocusRequired, false);
  assert.equal(last.currentUsageSeconds, 30);
  assert.equal(f.tracker.getDebugState().resolution, 'page_hidden');
  const { formatDiagnosticReportText } = await import('../diagnostics/diagnosticReport.js');
  const text = formatDiagnosticReportText({ dailyLimits: { tracker: {
    ...f.tracker.getDebugState(), lastVisibleSample: last
  } } });
  assert.match(text, /Last resolution: page_hidden/);
  assert.match(text, /Last visible resolution: matched/);
  assert.match(text, /Last visible window focus required: no/);
});

test('unavailable diagnostic session storage does not interrupt Daily Limit accounting', async () => {
  const f = fixture({ sessionStorage: {
    async get() { throw new Error('Session read unavailable'); },
    async set() { throw new Error('Session write unavailable'); }
  } });
  await f.sample();f.at(30);await f.sample();
  assert.equal(await f.usage(), 30);
  assert.equal((await f.tracker.getLastVisibleSample()).currentUsageSeconds, 30);
});
