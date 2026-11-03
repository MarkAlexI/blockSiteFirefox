import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createDailyLimitTracker, isDailyLimitVisibilitySender } from '../rules/dailyLimitTracker.js';
import { DailyLimitManager } from '../rules/dailyLimitManager.js';

function fixture(initialVisibility = 'hidden') {
  const start = Date.parse('2026-11-03T12:00:00Z');
  let clock = start, generation = 0, probeHook = () => {};
  const data = {}, pending = [], listeners = new Map(), messages = [];
  const storage = {
    async get() { return structuredClone(data); },
    async set(values) { Object.assign(data, structuredClone(values)); }
  };
  const manager = new DailyLimitManager(storage);
  const tab = { id: 11, windowId: 7, active: true, url: 'https://tracked.example/' };
  let selected = tab;
  const document = {
    visibilityState: initialVisibility, hidden: initialVisibility === 'hidden',
    hasFocus() { return !this.hidden; },
    addEventListener(type, handler) {
      const values = listeners.get(type) || [];values.push(handler);listeners.set(type, values);
    }
  };
  const runtime = { sendMessage(message) {
    messages.push(structuredClone(message));
    const result = tracker.visibilityChanged({ ...message, tabId: tab.id, url: tab.url });
    pending.push(result);return result;
  } };
  class ClockDate extends Date { static now() { return clock; } }
  const realm = vm.createContext({ document, browser: { runtime }, Date: ClockDate, console });
  const tracker = createDailyLimitTracker({
    tabsApi: {
      async query(query) { return query.active ? [structuredClone(selected)] : [structuredClone(tab)]; },
      async get(id) { return structuredClone(id === tab.id ? tab : selected); }
    },
    scriptingApi: { async executeScript({ func }) {
      const result = vm.runInContext(`(${func.toString()})()`, realm);
      probeHook();
      return [{ frameId: 0, result }];
    } },
    alarmsApi: { async create() {}, async clear() {} },
    getRules: async () => [{ id: 1, blockURL: 'tracked.example', category: 'social',
      assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'daily_limit',
        schedule: null, dailyLimit: { minutes: 10 } }], isWhitelist: false }],
    getRuleListState: async () => ({ activeRuleListId: 'general', lists: [{ id: 'general', disabledCategories: [] }] }),
    getFocusSessionState: async () => ({ focusActive: false }),
    dailyLimitManager: manager, dnrSynchronizer: { async requestSync() {} },
    getNow: () => new Date(clock), getStateGeneration: () => generation, logger: { info() {}, log() {} }
  });
  return {
    start, data, manager, tracker, tab, messages, document,
    listenerCount: () => (listeners.get('visibilitychange') || []).length,
    invalidate: () => { generation++; },
    setProbeHook: hook => { probeHook = hook; },
    selectOptions: () => { selected = { id: 21, windowId: 17, active: true, url: 'moz-extension://self/options/options.html' }; },
    selectWebsite: () => { selected = tab; },
    setTime(milliseconds) { clock = start + milliseconds; },
    async sample() { return tracker.sample('minute_alarm', new Date(clock)); },
    async visibility(state, isTrusted = true) {
      document.visibilityState = state;document.hidden = state === 'hidden';
      for (const handler of listeners.get('visibilitychange') || []) handler({ isTrusted });
      while (pending.length) await Promise.all(pending.splice(0));
    },
    async usage() { return (await manager.getUsageSeconds(new Date(clock)))['1:general'] || 0; }
  };
}

test('returning from Android Options starts accounting before the first minute alarm', async () => {
  const f = fixture();
  await f.sample(); // Options obscures the tracked page; Android has no window-focus event.
  await f.visibility('visible');
  f.setTime(60000);await f.sample();
  f.setTime(120000);await f.sample();
  assert.equal(await f.usage(), 120, 'two minutes of visible browsing must not become one');
});

test('rule commit observes a matching background page even while Options is the current tab', async () => {
  const f = fixture();f.selectOptions();
  await f.tracker.observeMatchingPages();await f.sample();
  assert.equal(f.listenerCount(), 1);
  f.selectWebsite();await f.visibility('visible');
  f.setTime(60000);await f.sample();f.setTime(120000);await f.sample();
  assert.equal(await f.usage(), 120);
});

test('opening Options flushes the former foreground page even after native selection has changed', async () => {
  const f = fixture('visible');await f.sample();
  f.setTime(30000);f.selectOptions();await f.visibility('hidden');
  assert.equal(await f.usage(), 30);
});

test('one native observer per document ignores synthetic events and sends no page data', async () => {
  const f = fixture('visible');
  await f.sample();await f.sample();
  assert.equal(f.listenerCount(), 1);
  f.setTime(10000);await f.visibility('hidden', false);
  assert.equal(f.messages.length, 0);
  await f.visibility('hidden');
  assert.equal(f.messages.length, 1);
  assert.deepEqual(Object.keys(f.messages[0]).sort(), ['observedAt', 'type', 'visibilityState']);
});

test('a hidden event delayed in transit accounts only through its captured native boundary', async () => {
  const f = fixture('visible');await f.sample();
  f.document.visibilityState = 'hidden';f.document.hidden = true;
  f.setTime(50000);
  await f.tracker.visibilityChanged({ tabId: 11, url: f.tab.url, visibilityState: 'hidden', observedAt: f.start + 30000 });
  assert.equal(await f.usage(), 30);
});

test('resume without a delivered hidden event never charges the unknown screen-off gap', async () => {
  const f = fixture('visible');await f.sample();
  f.setTime(70000);await f.visibility('visible');
  f.setTime(100000);await f.sample();
  assert.equal(await f.usage(), 30);
});

for (const change of [
  { tabId: 12 }, { url: 'https://other.example/' },
  { observedAt: Date.parse('2026-11-03T12:00:01Z') },
  { observedAt: Date.parse('2026-11-03T11:58:29Z') },
  { visibilityState: 'hidden' }
]) test(`foreign, stale, future or mismatched visibility input leaves accounting untouched: ${JSON.stringify(change)}`, async () => {
  const f = fixture('visible');await f.sample();
  const before = structuredClone(f.data);
  await f.tracker.visibilityChanged({ tabId: 11, url: f.tab.url, visibilityState: 'visible', observedAt: f.start, ...change });
  assert.deepEqual(f.data, before);
});

test('a late same-document event cannot rewind a newer foreground sample', async () => {
  const f = fixture('visible');await f.sample();
  f.setTime(60000);await f.sample();
  const before = structuredClone(f.data);f.setTime(70000);
  await f.tracker.visibilityChanged({ tabId: 11, url: f.tab.url, visibilityState: 'visible', observedAt: f.start + 50000 });
  assert.deepEqual(f.data, before);
});

test('a previous-day event cannot replace the current day even when only 20ms old', async () => {
  const f = fixture('visible');await f.sample();
  const midnight = new Date(f.start);midnight.setHours(24, 0, 0, 0);
  const offset = midnight.getTime() - f.start;
  f.setTime(offset + 10);
  const before = structuredClone(f.data);
  await f.tracker.visibilityChanged({ tabId: 11, url: f.tab.url, visibilityState: 'visible',
    observedAt: f.start + offset - 10 });
  assert.deepEqual(f.data, before);
});

test('a rules generation changed during the native probe preserves the existing segment', async () => {
  const f = fixture('visible');await f.sample();
  f.setTime(10000);const before = structuredClone(f.data);
  f.setProbeHook(f.invalidate);
  await f.tracker.visibilityChanged({ tabId: 11, url: f.tab.url, visibilityState: 'visible', observedAt: f.start + 10000 });
  assert.deepEqual(f.data, before);
});

test('only this extension top-frame HTTP(S) content sender can report visibility', () => {
  const message = { type: 'daily-limit:visibility', visibilityState: 'visible', observedAt: 1234 };
  const sender = { id: 'self', frameId: 0, tab: { id: 11 }, url: 'https://tracked.example/' };
  const runtime = { id: 'self' };
  assert.equal(isDailyLimitVisibilitySender(message, sender, runtime), true);
  for (const patch of [{ id: 'other' }, { frameId: 1 }, { frameId: undefined }, { tab: undefined },
    { url: 'moz-extension://self/options/options.html' }, { url: 'about:blank' }, { url: 'invalid' }]) {
    assert.equal(isDailyLimitVisibilitySender(message, { ...sender, ...patch }, runtime), false);
  }
  for (const patch of [{ type: 'other' }, { visibilityState: 'prerender' }, { observedAt: NaN },
    { observedAt: '1234' }, { observedAt: -1 }]) {
    assert.equal(isDailyLimitVisibilitySender({ ...message, ...patch }, sender, runtime), false);
  }
});

test('native page visibility closes awake time and starts a fresh segment after screen-off', async () => {
  const f = fixture('visible');
  await f.sample();
  f.setTime(30000);await f.visibility('hidden');
  f.setTime(70000);await f.visibility('visible');
  f.setTime(100000);await f.sample();
  assert.equal(await f.usage(), 60, '30 seconds before and after sleep; the hidden 40 seconds are excluded');
});


for (const unavailable of [{ discarded: true }, { status: 'loading' }]) {
  test(`preparing observers does not wake an unavailable background page: ${JSON.stringify(unavailable)}`, async () => {
    const f = fixture();Object.assign(f.tab, unavailable);
    await f.tracker.observeMatchingPages();
    assert.equal(f.listenerCount(), 0);
    assert.deepEqual(f.data, {});
  });
}
