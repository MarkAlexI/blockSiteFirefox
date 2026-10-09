import assert from 'node:assert/strict';
import { installWindowObserver, readWindowObserver, removeWindowObserver,
  windowOperation, nativeWindowSnapshot, assertWindowPhase, assertWindowAccounting } from './window-probes.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const initialUsage = { '21:general': 40, '22:general': 60 };
const rules = [21, 22].map(id => ({ id, blockURL: `window-${id}.bd-e2e.test`, redirectURL: '',
  category: 'social', isWhitelist: false, assignments: [{ listId: 'general', disabledByUser: false,
    blockingMode: 'daily_limit', dailyLimit: { minutes: id === 21 ? 1 : 2 }, schedule: null }] }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function eventually(read, check, label, timeout = 15_000) {
  const until = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await delay(100);
  } while (Date.now() < until);
  assert.fail(label + ': timeout; last=' + JSON.stringify(value));
}

export const multiWindowScenarios = [{
  id: '44', nativeDesktop: true,
  title: 'two native windows and tab moves account only the focused foreground and preserve UI/DNR budgets',
  async run(e) {
    assert.equal(e.config?.headless ?? e.testInfo.project.use.headless, false, 'requires real headed browser window focus');
    await e.seed({ rules, usage: initialUsage });
    const options = await e.openOptions();
    await e.reconcile(options); // Setup only; subsequent transitions use native window/tab events.
    const stable = await e.state();
    const evidence = { schemaVersion: 1, scope: 'native normal windows, not session restore or OS sleep', phases: [] };
    const op = input => options.evaluate(windowOperation, input);
    const observation = () => options.evaluate(readWindowObserver);
    const ids = [];
    const snapshot = () => options.evaluate(nativeWindowSnapshot, { ids });
    const focused = (value, tabId, windowId, key) => {
      const tab = value.tabs.find(item => item.id === tabId);
      return value.windows.find(item => item.id === windowId)?.focused === true &&
        tab?.windowId === windowId && tab.active && tab.status === 'complete' &&
        tab.document?.title === 'BD E2E fixture' && tab.document.visible === 'visible' &&
        tab.document.hidden === false && tab.document.focused === true &&
        same(value.dailyRuleUsage.lastSample?.assignmentKeys, [key]);
    };
    const stableForeground = async (tabId, windowId, key) => {
      const value = await eventually(async () => ({ snapshot: await snapshot(), observation: await observation() }), value => {
        const last = value.observation.history.at(-1);
        return focused(value.snapshot, tabId, windowId, key) && (!last || Date.now() - last.at >= 200);
      }, 'native foreground settled after window creation/focus delivery');
      assert.equal(value.observation.overflow, false);
      return value.snapshot;
    };
    const focus = async (tabId, windowId, key) => {
      await op({ op: 'focus', tabId, windowId });
      // onFocusChanged can contain NONE between windows. Do not measure a
      // stable phase while the creation/focus handlers are still writing.
      return stableForeground(tabId, windowId, key);
    };
    await options.evaluate(installWindowObserver);
    try {
      const first = await op({ op: 'current' });
      const a = await op({ op: 'create-tab', windowId: first.id, url: 'http://window-21.bd-e2e.test/start', active: true });
      ids.push(a.id);
      const b = await op({ op: 'create-tab', windowId: first.id, url: 'http://window-22.bd-e2e.test/start', active: false });
      ids.push(b.id);
      const second = await op({ op: 'create-window', tabId: b.id });
      assert.notEqual(first.id, second.id, 'two distinct real browser windows');
      evidence.identity = { a: a.id, b: b.id, first: first.id, second: second.id };
      await focus(a.id, first.id, '21:general');

      async function phase(label, ownerId, backgroundId, windowId, owner, inactive) {
        // Begin after focus/state preconditions. Querying a hidden extension
        // reader does not select it or emulate page visibility.
        const before = await stableForeground(ownerId, windowId, owner);
        const record = { label, before };
        evidence.phases.push(record);
        assert.ok(focused(before, ownerId, windowId, owner), JSON.stringify(before));
        assert.equal(before.tabs.find(item => item.id === backgroundId).active, true,
          'positive control: background tab is active in its own window');
        assert.equal(before.tabs.find(item => item.id === backgroundId).document.visible, 'visible',
          'positive control: unfocused window contains a visible active document');
        assert.equal(before.tabs.find(item => item.id === backgroundId).document.focused, false);
        const from = (await observation()).history.length;
        await delay(2200); // Genuine elapsed time, followed by real native navigation events.
        const url = `http://window-${backgroundId === a.id ? 21 : 22}.bd-e2e.test/${label}`;
        await op({ op: 'navigate', tabId: backgroundId, url });
        record.url = url;
        const completed = await eventually(async () => ({ snapshot: await snapshot(), observation: await observation() }), value => {
          const tab = value.snapshot.tabs.find(item => item.id === backgroundId);
          const events = value.observation.history.slice(from);
          return tab?.url === url && tab.status === 'complete' && tab.document?.url === url &&
            value.snapshot.dailyRuleUsage.lastSample?.timestamp >= tab.document.timeOrigin &&
            events.some(event => event.kind === 'updated' && event.tabId === backgroundId && event.change.status === 'complete') &&
            Date.now() - value.observation.history.at(-1).at >= 200;
        }, 'background load completion and native writes settled before the next transition');
        const after = completed.snapshot;
        const all = completed.observation;
        assert.equal(all.overflow, false);
        record.after = after; record.events = all.history.slice(from);
        assert.equal(after.windows.find(item => item.id === windowId).focused, true);
        assert.equal(after.tabs.find(item => item.id === ownerId).document.focused, true);
        assert.equal(after.tabs.find(item => item.id === backgroundId).document.focused, false);
        assert.ok(record.events.some(event => event.kind === 'updated' && event.tabId === backgroundId && event.change.status === 'complete'),
          'real background onUpdated completion observed');
        record.accounting = assertWindowPhase({ ...record, owner, inactive, windowId, events: record.events });
      }

      await phase('a-focused-b-loads', a.id, b.id, first.id, '21:general', '22:general');
      await focus(b.id, second.id, '22:general');
      await phase('b-focused-a-loads', b.id, a.id, second.id, '22:general', '21:general');

      await op({ op: 'move', tabId: a.id, windowId: second.id });
      const together = await focus(b.id, second.id, '22:general');
      assert.equal(together.tabs.find(tab => tab.id === a.id).windowId, second.id);
      assert.equal(together.tabs.find(tab => tab.id === a.id).active, false);
      assert.equal(together.tabs.find(tab => tab.id === a.id).document.visible, 'hidden');
      await op({ op: 'move', tabId: a.id, windowId: first.id });
      await op({ op: 'activate', tabId: a.id }); // Per-window activation; global focus is still explicit.
      await focus(b.id, second.id, '22:general');
      await phase('b-focused-moved-a-loads', b.id, a.id, second.id, '22:general', '21:general');
      const moved = await observation();
      for (const [oldWindowId, newWindowId] of [[first.id, second.id], [second.id, first.id]]) {
        assert.ok(moved.history.some(event => event.kind === 'detached' && event.tabId === a.id && event.oldWindowId === oldWindowId), 'actual detach of the same tab');
        assert.ok(moved.history.some(event => event.kind === 'attached' && event.tabId === a.id && event.newWindowId === newWindowId), 'actual attach of the same tab');
      }
      assert.ok(moved.history.some(event => event.kind === 'window-created' && event.windowId === second.id));
      evidence.afterMoves = await snapshot();

      await focus(a.id, first.id, '21:general');
      // Native Daily Limit deadline, without rearming alarms or requesting a
      // corrective intent. One minute rule starts with 20 seconds remaining.
      evidence.exhausted = await eventually(snapshot, value => value.dnr.includes(21) &&
        value.dailyRuleUsage.usageSeconds['21:general'] >= 60 &&
        value.tabs.find(tab => tab.id === a.id)?.removed === true, 'native foreground deadline installs DNR', 35_000);
      assert.deepEqual(evidence.exhausted.dnr, [21]);
      assert.ok(evidence.exhausted.dailyRuleUsage.usageSeconds['22:general'] < 120);
      const history = await observation();
      assert.equal(history.overflow, false);
      assertWindowAccounting(history.history, initialUsage);
      assert.ok(history.history.some(event => event.kind === 'removed' && event.tabId === a.id && event.windowId === first.id),
        'production expiry cleanup closed the moved exhausted tab');
      assert.ok(evidence.exhausted.windows.some(window => window.id === first.id), 'Options keeps the first window open');
      assert.ok(evidence.exhausted.windows.some(window => window.id === second.id), 'unexhausted second window survives');
      evidence.history = history;

      // Select native Options to close the foreground segment before comparing
      // exact reader values. This Popup is a reader tab, not a toolbar claim.
      if (options.front) await options.front(); else await options.bringToFront();
      await eventually(snapshot, value => value.dailyRuleUsage.lastSample?.assignmentKeys.length === 0, 'Options closes the foreground sample');
      const popup = await e.openPopup();
      const final = await e.state();
      const expected = rules.map(rule => {
        const minutes = rule.assignments[0].dailyLimit.minutes;
        const spent = final.dailyRuleUsage.usageSeconds[rule.id + ':general'];
        return { id: rule.id, usage: [Math.floor(Math.min(spent, minutes * 60) / 6) / 10, minutes], exhausted: spent >= minutes * 60 };
      });
      const rows = page => page.evaluate(() => [...document.querySelectorAll('#rules-container tr[data-rule-id], #rules-container .rule[data-rule-id]')].map(row => {
        const status = row.querySelector('.daily-limit-status, .rule-daily-limit-popup');
        const values = status?.textContent.match(/^([\d.]+)\s*\/\s*(\d+)/);
        return { id: Number(row.dataset.ruleId), usage: values ? [Number(values[1]), Number(values[2])] : null,
          exhausted: Boolean(status?.classList.contains('limit-reached')) };
      }).sort((a, b) => a.id - b.id));
      for (const page of [options, popup]) await eventually(() => rows(page), value => same(value, expected), 'native Options/Popup reader budgets');
      evidence.readers = expected;
      for (const key of ['credentials', 'rules', 'ruleLists', 'activeRuleListId', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions', 'focusSession']) {
        assert.deepEqual(final[key], stable[key], key + ' unchanged by window operations');
      }
      assert.deepEqual(final.pendingDailyUsageRemaps, []);
      const c = await op({ op: 'create-tab', windowId: first.id, url: 'http://window-21.bd-e2e.test/exhausted', active: false });
      ids.push(c.id);
      const blocked = await eventually(snapshot, value => value.tabs.find(tab => tab.id === c.id).url?.includes('/blocked.html'), 'actual post-expiry DNR navigation');
      assert.equal(new URL(blocked.tabs.find(tab => tab.id === c.id).url).searchParams.get('reason'), 'daily_limit');
      const allowedUrl = 'http://window-22.bd-e2e.test/allowed';
      await op({ op: 'navigate', tabId: b.id, url: allowedUrl });
      evidence.navigation = await eventually(snapshot, value => {
        const tab = value.tabs.find(item => item.id === b.id);
        return tab.url === allowedUrl && tab.document?.title === 'BD E2E fixture';
      }, 'unexhausted background window remains allowed');
      assert.deepEqual(e.pageErrors, []);
    } finally {
      try { evidence.finalObservation = await observation(); }
      finally {
        await options.evaluate(removeWindowObserver);
        if (e.testInfo) await e.testInfo.attach('native-multi-window', { contentType: 'application/json', body: JSON.stringify(evidence, null, 2) });
        else e.result.nativeMultiWindow = evidence;
      }
    }
  }
}];
