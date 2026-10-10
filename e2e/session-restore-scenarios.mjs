import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeTabShortcut, nativeTabWindow } from './native-tab-shortcut.mjs';
import { installWindowObserver, readWindowObserver, removeWindowObserver,
  windowOperation, nativeWindowSnapshot, assertWindowPhase, assertWindowAccounting } from './window-probes.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const initialUsage = { '21:general': 40, '22:general': 60 };
const rules = [21, 22].map(id => ({ id, blockURL: `restore-${id}.bd-e2e.test`, redirectURL: '', category: 'social',
  isWhitelist: false, assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'daily_limit',
    dailyLimit: { minutes: id === 21 ? 1 : 2 }, schedule: null }] }));
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

export async function restoreProbe(input) {
  const api = globalThis.browser || chrome;
  if (input.op === 'current-tab') {
    const tab = await api.tabs.getCurrent();
    return { id: tab.id, windowId: tab.windowId };
  }
  if (input.op === 'deadline') return (await api.alarms.get('daily_limit_deadline')) || null;
  if (input.op === 'find') return (await api.tabs.query({})).filter(tab => tab.id !== input.oldId && tab.url === input.url)
    .map(tab => ({ id: tab.id, windowId: tab.windowId, active: tab.active, status: tab.status }));
  if (input.op === 'title') {
    await api.scripting.executeScript({ target: { tabId: input.tabId }, func: title => { document.title = title; }, args: [input.title] });
    return true;
  }
  throw new Error('Unknown native restore probe');
}

export function assertRestoreDeadline(value, key, limitSeconds) {
  assert.ok(value.deadline, 'a real current foreground deadline exists');
  assert.equal(value.deadline.name, 'daily_limit_deadline');
  assert.deepEqual(value.dailyRuleUsage.lastSample.assignmentKeys, [key]);
  const expected = value.dailyRuleUsage.lastSample.timestamp + (limitSeconds - value.dailyRuleUsage.usageSeconds[key]) * 1000;
  assert.ok(Math.abs(value.deadline.scheduledTime - expected) < 1000,
    'deadline follows the retained current budget, including native alarm deduplication');
}

export const sessionRestoreScenarios = [{
  id: '45', nativeDesktop: true, nativeKeyboard: true,
  title: 'native undo-close restores a tab without resetting budget or duplicating accounting and deadline blocking',
  async run(e) {
    assert.equal(e.config?.headless ?? e.testInfo.project.use.headless, false, 'requires real headed native keyboard input');
    await e.seed({ rules, usage: initialUsage });
    const options = await e.openOptions();
    await e.reconcile(options); // Setup only; no corrective intent after native close/restore.
    const stable = await e.state();
    const evidence = { schemaVersion: 1, scope: 'Linux/X11 native Ctrl+W then Ctrl+Shift+T in the same browser process; not startup session restore', phases: [] };
    const op = input => options.evaluate(windowOperation, input);
    const probe = input => options.evaluate(restoreProbe, input);
    const shortcut = async (action, tabId) => {
      const title = 'BD E2E ' + action + '-' + randomUUID();
      await probe({ op: 'title', tabId, title });
      await eventually(() => nativeTabWindow(), value => value.title.includes(title), 'native desktop title reflects the selected fixture document');
      return nativeTabShortcut({ action, expectedTitle: title });
    };
    const observation = () => options.evaluate(readWindowObserver);
    const ids = [];
    const snapshot = async () => ({ ...await options.evaluate(nativeWindowSnapshot, { ids }), deadline: await probe({ op: 'deadline' }) });
    const focused = (value, id, key) => {
      const tab = value.tabs.find(item => item.id === id);
      return tab?.active && tab.status === 'complete' && tab.document?.title === 'BD E2E fixture' &&
        tab.document.visible === 'visible' && !tab.document.hidden && tab.document.focused &&
        value.windows.find(window => window.id === tab.windowId)?.focused &&
        same(value.dailyRuleUsage.lastSample?.assignmentKeys, [key]);
    };
    const settled = async (id, key) => {
      const result = await eventually(async () => ({ state: await snapshot(), history: await observation() }), value =>
        focused(value.state, id, key) && (!value.history.history.length || Date.now() - value.history.history.at(-1).at >= 200),
      'native foreground and durable writes settled');
      assert.equal(result.history.overflow, false);
      return result.state;
    };
    await options.evaluate(installWindowObserver);
    try {
      const window = await op({ op: 'current' });
      const reader = await probe({ op: 'current-tab' });
      // B is the adjacent predecessor and was selected before A. Native close
      // can choose it without a test-driven focus correction.
      const b = await op({ op: 'create-tab', windowId: window.id, url: 'http://restore-22.bd-e2e.test/start', active: false });
      const a = await op({ op: 'create-tab', windowId: window.id, url: 'http://restore-21.bd-e2e.test/start', active: false });
      ids.push(a.id, b.id);
      evidence.identity = { old: a.id, anchor: b.id, window: window.id };
      await op({ op: 'focus', tabId: b.id, windowId: window.id }); await settled(b.id, '22:general');
      await op({ op: 'focus', tabId: a.id, windowId: window.id });

      async function phase(label, id, key, inactive, navigateId, url) {
        const before = await settled(id, key);
        const from = (await observation()).history.length;
        const record = { label, before }; evidence.phases.push(record);
        await delay(2200); // Real elapsed foreground time.
        await op({ op: 'navigate', tabId: navigateId, url });
        const result = await eventually(async () => ({ state: await snapshot(), history: await observation() }), value => {
          const tab = value.state.tabs.find(item => item.id === navigateId);
          return tab?.url === url && tab.status === 'complete' && tab.document?.url === url &&
            value.state.dailyRuleUsage.lastSample.timestamp >= tab.document.timeOrigin &&
            value.history.history.slice(from).some(event => event.kind === 'updated' && event.tabId === navigateId && event.change.status === 'complete') &&
            Date.now() - value.history.history.at(-1).at >= 200;
        }, 'native load completion and accounting writes settled');
        record.after = result.state; record.events = result.history.history.slice(from);
        assert.ok(focused(record.after, id, key));
        record.accounting = assertWindowPhase({ ...record, owner: key, inactive, windowId: window.id });
        assertRestoreDeadline(record.after, key, key === '21:general' ? 60 : 120);
        return record.after;
      }

      const restoreUrl = 'http://restore-21.bd-e2e.test/restore-me';
      evidence.beforeClose = await phase('before-close', a.id, '21:general', '22:general', a.id, restoreUrl);
      evidence.closeShortcut = await shortcut('close', a.id);
      evidence.closed = await settled(b.id, '22:general');
      assert.equal(evidence.closed.tabs.find(tab => tab.id === a.id).removed, true, 'original native tab is gone');
      assert.ok((await observation()).history.some(event => event.kind === 'removed' && event.tabId === a.id));
      assertRestoreDeadline(evidence.closed, '22:general', 120);
      evidence.absent = await phase('while-closed', b.id, '22:general', '21:general', b.id, 'http://restore-22.bd-e2e.test/while-closed');
      const restoreFrom = (await observation()).history.length;
      evidence.restoreShortcut = await shortcut('restore', b.id);
      const restored = await eventually(() => probe({ op: 'find', oldId: a.id, url: restoreUrl }),
        value => value.length === 1 && value[0].active && value[0].status === 'complete', 'native browser undo-close produced one replacement tab');
      const restoredId = restored[0].id;
      ids.push(restoredId); evidence.identity.restored = restoredId;
      assert.notEqual(restoredId, a.id);
      assert.equal(restored[0].windowId, window.id);
      evidence.restored = await settled(restoredId, '21:general');
      assert.equal(evidence.restored.tabs.find(tab => tab.id === a.id).removed, true);
      assert.ok(evidence.restored.tabs.find(tab => tab.id === restoredId).document.timeOrigin > evidence.beforeClose.tabs.find(tab => tab.id === a.id).document.timeOrigin,
        'native restoration produced a new document');
      const created = (await observation()).history.slice(restoreFrom).filter(event => event.kind === 'created' && event.tab.id === restoredId);
      assert.equal(created.length, 1, 'exactly one replacement native tab creation was observed');
      const elapsed = evidence.restored.dailyRuleUsage.lastSample.timestamp - evidence.absent.dailyRuleUsage.lastSample.timestamp;
      let gain = 0;
      for (const key of Object.keys(initialUsage)) {
        const delta = evidence.restored.dailyRuleUsage.usageSeconds[key] - evidence.absent.dailyRuleUsage.usageSeconds[key];
        assert.ok(delta >= 0, 'undo-close cannot reset either spent budget');
        gain += delta;
      }
      assert.ok(gain <= Math.floor(elapsed / 1000), 'native transition can charge at most its genuine elapsed foreground time');
      assertRestoreDeadline(evidence.restored, '21:general', 60);
      evidence.afterRestore = await phase('restored-foreground', restoredId, '21:general', '22:general', restoredId,
        'http://restore-21.bd-e2e.test/after-restore');
      evidence.exhausted = await eventually(snapshot, value => value.dnr.includes(21) &&
        value.dailyRuleUsage.usageSeconds['21:general'] >= 60 && value.tabs.find(tab => tab.id === restoredId)?.removed === true,
      'retained native foreground deadline blocks and closes the restored tab', 35_000);
      assert.deepEqual(evidence.exhausted.dnr, [21]);
      assert.ok(evidence.exhausted.dailyRuleUsage.usageSeconds['22:general'] < 120);
      const history = await observation();
      assert.equal(history.overflow, false); assertWindowAccounting(history.history, initialUsage);
      assert.ok(history.history.some(event => event.kind === 'removed' && event.tabId === restoredId), 'production expiry removed the restored tab');
      evidence.history = history;
      // Native shortcuts change the selected tab independently of the driver's
      // cached current handle. Select Options explicitly through native APIs.
      await op({ op: 'focus', tabId: reader.id, windowId: reader.windowId });
      await eventually(snapshot, value => value.dailyRuleUsage.lastSample?.assignmentKeys.length === 0 && !value.deadline,
        'Options closes accounting and clears the native deadline');
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
      for (const page of [options, popup]) await eventually(() => rows(page), value => same(value, expected), 'Options/Popup reader retained budgets');
      evidence.readers = expected;
      for (const key of ['credentials', 'rules', 'ruleLists', 'activeRuleListId', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions', 'focusSession']) {
        assert.deepEqual(final[key], stable[key], key + ' unchanged by native close/restore');
      }
      assert.deepEqual(final.pendingDailyUsageRemaps, []);
      const blockedTab = await op({ op: 'create-tab', windowId: window.id, url: 'http://restore-21.bd-e2e.test/exhausted', active: false });
      ids.push(blockedTab.id);
      const blocked = await eventually(snapshot, value => value.tabs.find(tab => tab.id === blockedTab.id)?.url?.includes('/blocked.html'), 'actual post-restore expiry DNR navigation');
      assert.equal(new URL(blocked.tabs.find(tab => tab.id === blockedTab.id).url).searchParams.get('reason'), 'daily_limit');
      const allowed = 'http://restore-22.bd-e2e.test/allowed';
      await op({ op: 'navigate', tabId: b.id, url: allowed });
      evidence.navigation = await eventually(snapshot, value => value.tabs.find(tab => tab.id === b.id)?.document?.url === allowed,
        'unexhausted anchor remains allowed');
      assert.deepEqual(e.pageErrors, []);
    } finally {
      try { evidence.finalObservation = await observation(); }
      finally {
        await options.evaluate(removeWindowObserver);
        if (e.testInfo) await e.testInfo.attach('native-session-tab-restore', { contentType: 'application/json', body: JSON.stringify(evidence, null, 2) });
        else e.result.nativeSessionTabRestore = evidence;
      }
    }
  }
}];
