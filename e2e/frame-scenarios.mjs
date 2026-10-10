import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { frameUrls } from './frame-fixture.mjs';
import { installWindowObserver, readWindowObserver, removeWindowObserver, windowOperation } from './window-probes.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function eventually(read, check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (check(last)) return last;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(label + ': ' + JSON.stringify(last));
}

export async function frameSnapshot(tabId) {
  const api = globalThis.browser || chrome;
  const tab = await api.tabs.get(tabId);
  const frames = await api.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => ({
    url: location.href, role: document.body.dataset.frameRole || null, referrer: document.referrer,
    top: window === window.top, directChild: window !== window.top && window.parent === window.top,
    children: [...document.querySelectorAll('iframe')].map(frame => frame.src),
    visible: document.visibilityState, focused: document.hasFocus(), timeOrigin: performance.timeOrigin
  }) });
  return { at: Date.now(), tab: { id: tab.id, windowId: tab.windowId, url: tab.url, active: tab.active, status: tab.status },
    frames: frames.map(({ frameId, result }) => ({ frameId, ...result })),
    ...await api.storage.local.get(['dailyRuleUsage', 'pendingDailyUsageRemaps']),
    deadline: await api.alarms.get('daily_limit_deadline') || null,
    dnr: (await api.declarativeNetRequest.getDynamicRules()).map(rule => rule.id).sort((a, b) => a - b) };
}

// Navigate the real nested browsing context by changing its parent's iframe src.
// No top-level navigation, message, accounting sample or event is synthesized.
export async function navigateNestedFrame(input) {
  const api = globalThis.browser || chrome;
  const results = await api.scripting.executeScript({ target: { tabId: input.tabId, frameIds: [input.middleId] },
    func: url => { document.querySelector('#child').src = url; return true; }, args: [input.url] });
  return results.map(({ frameId, result }) => ({ frameId, result }));
}

export function observeFrameAlarms() {
  const api = globalThis.browser || chrome;
  const view = globalThis.__bdWindowObserver;
  const listener = alarm => view.add('frame-alarm', { alarm });
  api.alarms.onAlarm.addListener(listener);
  view.listeners.push([api.alarms.onAlarm, listener]);
  return true;
}

export function assertFrameTree(snapshot, urls) {
  assert.equal(snapshot.tab.url, urls.main, 'the browser tab retains the parent URL');
  assert.equal(snapshot.frames.length, 3, 'three real HTTP documents loaded, including the blocked Basic host');
  const frames = Object.fromEntries(snapshot.frames.map(frame => [frame.role, frame]));
  assert.deepEqual(Object.keys(frames).sort(), ['leaf', 'main', 'middle']);
  assert.equal(new Set(snapshot.frames.map(frame => frame.frameId)).size, 3, 'native extension frame IDs are distinct');
  for (const role of ['main', 'middle', 'leaf']) assert.equal(frames[role].url, urls[role], role + ' document URL');
  assert.equal(frames.main.frameId, 0, 'native extension main frame ID');
  for (const role of ['middle', 'leaf']) assert.ok(Number.isInteger(frames[role].frameId) && frames[role].frameId > 0);
  assert.equal(frames.main.top, true);
  assert.equal(frames.middle.top, false); assert.equal(frames.middle.directChild, true);
  assert.equal(frames.leaf.top, false); assert.equal(frames.leaf.directChild, false, 'the leaf is genuinely nested');
  // Cross-origin referrers can be reduced to their origin. DOM child URLs and
  // parent/top identity above establish nesting without requiring full paths.
  assert.equal(new URL(frames.middle.referrer).origin, new URL(urls.main).origin, 'real immediate parent origin');
  assert.equal(new URL(frames.leaf.referrer).origin, new URL(urls.middle).origin, 'real nested parent origin');
  assert.deepEqual(frames.main.children, [urls.middle]);
  assert.deepEqual(frames.middle.children, [urls.leaf]);
  assert.deepEqual(frames.leaf.children, []);
  return frames;
}

const rules = [
  { id: 21, blockURL: 'frame-daily.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
    assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'daily_limit', dailyLimit: { minutes: 1 }, schedule: null }] },
  { id: 22, blockURL: 'frame-basic.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
    assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', dailyLimit: null, schedule: null }] }
];

export const frameScenarios = [{
  id: '46', nativeDesktop: true,
  title: 'nested HTTP frames preserve parent accounting while Basic and exhausted Daily Limit block top-level navigation',
  async run(e) {
    assert.equal(e.config?.headless ?? e.testInfo.project.use.headless, false, 'real headed tab focus');
    await e.seed({ rules, usage: { '21:general': 40 } });
    const options = await e.openOptions(); await e.reconcile(options); // Initial fixture only.
    await eventually(async () => (await e.state()).dnr.map(rule => rule.id), ids => same(ids, [22]), 'initial Basic DNR');
    const stable = await e.state();
    const urls = frameUrls(randomUUID());
    const evidence = { schemaVersion: 1, scope: 'native scripting frame IDs, DOM nesting, DNR navigation and tab accounting; not webRequest type/parentFrameId', urls };
    const op = input => options.evaluate(windowOperation, input);
    const observation = () => options.evaluate(readWindowObserver);
    await options.evaluate(installWindowObserver);
    await options.evaluate(observeFrameAlarms);
    try {
      const parent = await e.newPage(urls.main);
      const target = await options.evaluate(async url => {
        const api = globalThis.browser || chrome;
        const tabs = await api.tabs.query({ url });
        if (tabs.length !== 1) throw new Error('Expected exactly one fixture parent tab');
        return { tabId: tabs[0].id, windowId: tabs[0].windowId };
      }, urls.main);
      evidence.target = target;
      const snapshot = () => options.evaluate(frameSnapshot, target.tabId);
      const settle = async (url, keys) => eventually(async () => ({ state: await snapshot(), observation: await observation() }), value => {
        const main = value.state.frames.find(frame => frame.frameId === 0);
        const sample = value.state.dailyRuleUsage.lastSample;
        // An unmatched parent with no previous tracked segment preserves null;
        // recordSample intentionally avoids creating an empty durable sample.
        const accounting = keys.length === 0 ? sample === null :
          same(sample?.assignmentKeys, keys) && sample.timestamp >= main?.timeOrigin;
        return value.state.tab.active && value.state.tab.status === 'complete' && main?.url === url &&
          main.focused && main.visible === 'visible' && accounting &&
          Date.now() - (value.observation.history.at(-1)?.at || 0) >= 200;
      }, 'native document focus and accounting writes settled');
      await op({ op: 'focus', tabId: target.tabId, windowId: target.windowId });
      evidence.initial = (await settle(urls.main, [])).state;
      const initialFrames = assertFrameTree(evidence.initial, urls);
      assert.equal(evidence.initial.deadline, null, 'an iframe does not arm a foreground deadline');
      const changed = frameUrls(new URL(urls.main).searchParams.get('token'), 'navigated');
      await delay(2200); // Real elapsed time while only the unmatched parent is foreground.
      assert.deepEqual(await options.evaluate(navigateNestedFrame, { ...target, middleId: initialFrames.middle.frameId, url: changed.leaf }),
        [{ frameId: initialFrames.middle.frameId, result: true }]);
      evidence.navigated = await eventually(snapshot, value => value.frames.some(frame => frame.url === changed.leaf && frame.timeOrigin > initialFrames.leaf.timeOrigin), 'real nested child navigation');
      const navigated = assertFrameTree(evidence.navigated, changed);
      assert.equal(navigated.middle.frameId, initialFrames.middle.frameId);
      assert.equal(navigated.leaf.frameId, initialFrames.leaf.frameId, 'native child frame ID survives document navigation');
      // A genuine top-level reload supplies an accounting event even in browsers
      // that do not emit tabs.onUpdated for child-only navigation.
      await parent.goto(urls.main);
      evidence.parentReload = (await settle(urls.main, [])).state;
      assertFrameTree(evidence.parentReload, urls);
      evidence.embeddedHistory = (await observation()).history;
      for (const sample of [...evidence.embeddedHistory.filter(event => event.kind === 'usage').map(event => event.value), evidence.parentReload.dailyRuleUsage]) {
        assert.deepEqual(sample.usageSeconds, { '21:general': 40 }, 'iframe loads never charge the parent budget in any observed write');
        assert.equal(sample.lastSample, null, 'no tracked foreground segment exists for the parent');
      }
      assert.equal(evidence.parentReload.deadline, null);

      // Positive control: the identical Daily Limit document really charges when
      // it becomes the foreground top-level document.
      await parent.goto(urls.leaf);
      evidence.topLevel = (await settle(urls.leaf, ['21:general'])).state;
      assert.ok(evidence.topLevel.deadline, 'top-level Daily Limit arms a native deadline');
      await delay(2200);
      await parent.goto(changed.leaf);
      evidence.charged = (await settle(changed.leaf, ['21:general'])).state;
      assert.ok(evidence.charged.dailyRuleUsage.usageSeconds['21:general'] >= 42, 'positive control: real top-level time is charged');
      assert.deepEqual(evidence.charged.dnr, [22]);
      // Stay foreground: the existing native deadline, without another intent,
      // must exhaust the rule, install DNR and close this actual top-level tab.
      evidence.expiry = await eventually(async () => ({ state: await e.state(), observation: await observation(), live: await options.evaluate(async id => {
        const api = globalThis.browser || chrome;
        return (await api.tabs.query({})).some(tab => tab.id === id);
      }, target.tabId) }), value => value.state.dailyRuleUsage.usageSeconds['21:general'] >= 60 &&
        same(value.state.dnr.map(rule => rule.id).sort((a, b) => a - b), [21, 22]) && !value.live &&
        value.observation.history.some(event => event.kind === 'frame-alarm' && event.alarm.name === 'daily_limit_deadline' &&
          event.alarm.scheduledTime === evidence.charged.deadline.scheduledTime),
      'native Daily Limit deadline installs DNR and closes only its top-level tab', 35_000);
      const exhaustedUsage = evidence.expiry.state.dailyRuleUsage.usageSeconds;
      const exhausted = await e.newPage(urls.main);
      const exhaustedId = await options.evaluate(async url => {
        const api = globalThis.browser || chrome;
        const tabs = await api.tabs.query({ url });
        if (tabs.length !== 1) throw new Error('Expected one exhausted-fixture parent');
        return tabs[0].id;
      }, urls.main);
      evidence.exhaustedFrames = await options.evaluate(frameSnapshot, exhaustedId);
      assertFrameTree(evidence.exhaustedFrames, urls);
      assert.deepEqual(evidence.exhaustedFrames.dnr, [21, 22]);
      assert.equal(await exhausted.evaluate(() => location.href), urls.main);
      await e.assertBlocked(urls.middle, 'always');
      await e.assertBlocked(urls.leaf, 'daily_limit');
      evidence.afterBlocking = await options.evaluate(frameSnapshot, exhaustedId);
      assertFrameTree(evidence.afterBlocking, urls);
      const final = await e.state();
      assert.deepEqual(final.dailyRuleUsage.usageSeconds, exhaustedUsage, 'embedded exhausted document preserves the native spent budget');
      for (const key of ['credentials', 'rules', 'ruleLists', 'activeRuleListId', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions', 'focusSession']) assert.deepEqual(final[key], stable[key], key + ' unchanged');
      assert.deepEqual(final.pendingDailyUsageRemaps, []);
      const popup = await e.openPopup();
      for (const reader of [options, popup]) await eventually(() => reader.evaluate(() => {
        const row = document.querySelector('#rules-container [data-rule-id="21"]');
        const status = row?.querySelector('.daily-limit-status, .rule-daily-limit-popup');
        return { exhausted: Boolean(status?.classList.contains('limit-reached')), values: status?.textContent.match(/^([\d.]+)\s*\/\s*(\d+)/)?.slice(1) || null };
      }), value => value.exhausted && same(value.values, ['1', '1']), 'Options/Popup exhausted reader');
      evidence.final = final;
    } finally {
      try { evidence.history = await observation(); assert.equal(evidence.history.overflow, false); }
      finally {
        await options.evaluate(removeWindowObserver);
        if (e.testInfo) await e.testInfo.attach('native-nested-frames', { contentType: 'application/json', body: JSON.stringify(evidence, null, 2) });
        else e.result.nativeNestedFrames = evidence;
      }
    }
  }
}];
