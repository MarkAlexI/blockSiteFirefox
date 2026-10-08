import assert from 'node:assert/strict';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assignment = listId => ({ listId, disabledByUser: false,
  blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 10 } });
const rule = (id, listId = 'general', blockURL = 'usage.bd-e2e.test') => ({
  id, blockURL, redirectURL: '', category: 'social', isWhitelist: false,
  assignments: [assignment(listId)]
});
const dnrIds = state => state.dnr.map(item => item.id).sort((a, b) => a - b);
const send = (page, type, payload) => page.evaluate(message => {
  if (globalThis.browser) return browser.runtime.sendMessage(message);
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(response);
  }));
}, { type, payload });

async function eventually(read, expected, label, timeout = 15_000) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeout) {
    value = await read();
    try { assert.deepEqual(value, expected); return value; } catch { /* Wait for native updates. */ }
    await delay(250);
  }
  assert.deepEqual(value, expected, `${label}: timed out`);
}

const view = page => page.evaluate(() => [...document.querySelectorAll(
  '#rules-container tr[data-rule-id], #rules-container .rule[data-rule-id]'
)].map(row => {
  const status = row.querySelector('.daily-limit-status, .rule-daily-limit-popup');
  const values = status?.textContent.match(/^([\d.]+)\s*\/\s*(\d+)/);
  return { id: Number(row.dataset.ruleId), exhausted: Boolean(status?.classList.contains('limit-reached')),
    usage: values ? [Number(values[1]), Number(values[2])] : null };
}).sort((a, b) => a.id - b.id));

async function views(pages, ids, exhausted = [], used = {}) {
  const expected = ids.map(id => ({ id, exhausted: exhausted.includes(id),
    usage: Object.hasOwn(used, id) ? [used[id], 10] : null }));
  await Promise.all(pages.map((page, index) => eventually(() => view(page), expected, `reader ${index + 1}`)));
}

async function settled(e, usage, ids) {
  await eventually(async () => {
    const state = await e.state();
    return { usage: state.dailyRuleUsage.usageSeconds,
      pending: state.pendingDailyUsageRemaps, dnr: dnrIds(state) };
  }, { usage, pending: [], dnr: ids }, 'persisted usage, journal and native DNR');
}

function move(state, id, from, to) {
  const current = state.rules.find(item => item.id === id);
  return { ruleId: id, assignmentListId: from, blockURL: current.blockURL,
    redirectURL: current.redirectURL, assignment: assignment(to),
    expectedGeneration: state.rulesGeneration ?? null,
    expectedRevision: state.ruleRevisions?.[id] ?? null,
    expectedListRevisions: state.ruleListRevisions || {} };
}

export const readerScenarios = [
  {
    id: '18',
    title: 'readers stay consistent through three sequential delete/import cycles without restoring spent keys',
    async run(e) {
      await e.seed({ rules: [rule(21)], usage: { '21:general': 840 } });
      const a = await e.openOptions(); const b = await e.openOptions();
      const popup = await e.openPopup();
      const readers = [a, b, popup];
      // Three complete cycles are assertions within one scenario, not retries.
      for (let pass = 0; pass < 3; pass++) {
        if (pass) await e.seed({ rules: [rule(21)], usage: { '21:general': 840 } });
        await e.reconcile(a);
        await popup.goto(e.popupUrl);
        await settled(e, { '21:general': 840 }, [21]);
        await views(readers, [21], [21], { 21: 10 });
        await Promise.all([e.deleteRule(a, 21), popup.goto(e.popupUrl), view(b)]);
        await settled(e, {}, []);
        await views(readers, []);
        await popup.goto(e.popupUrl);
        await views(readers, []);
        await settled(e, {}, []);
        const domain = `imported-reader-${pass}.bd-e2e.test`;
        const imported = rule(99, 'general', domain);
        imported.assignments = [{ listId: 'general', disabledByUser: false,
          blockingMode: 'always', schedule: null, dailyLimit: null }];
        await Promise.all([e.importBackup(a, { rules: [imported] }), popup.goto(e.popupUrl), view(b)]);
        await eventually(async () => (await e.state()).rules.map(item => item.blockURL), [domain], 'imported rule');
        const ids = (await e.state()).rules.map(item => item.id).sort((a, b) => a - b);
        await settled(e, {}, ids);
        await views(readers, ids);
        await popup.goto(e.popupUrl);
        await views(readers, ids);
        await settled(e, {}, ids);
        await e.assertBlocked(`http://${domain}/page`);
      }
    }
  },
  {
    id: '19',
    title: 'readers preserve accepted and unrelated budgets through concurrent moves and a fresh chained move',
    async run(e) {
      await e.seed({ rules: [rule(21), rule(22, 'list-1', 'other-reader.bd-e2e.test'),
        rule(24, 'general', 'unrelated-reader.bd-e2e.test')],
      usage: { '21:general': 840, '22:list-1': 100, '24:general': 300 } });
      const a = await e.openOptions(); const b = await e.openOptions();
      const popup = await e.openPopup(); const readers = [a, b, popup];
      await e.reconcile(a);
      await views(readers, [21, 24], [21], { 21: 10, 24: 5 });
      const before = await e.state();
      const responses = await Promise.all([
        send(a, 'rules:update', move(before, 21, 'general', 'list-1')),
        send(b, 'rules:update', move(before, 22, 'list-1', 'general')),
        popup.goto(e.popupUrl)
      ]);
      assert.equal(responses[0].success, true, JSON.stringify(responses[0]));
      assert.equal(responses[1].success, true, JSON.stringify(responses[1]));
      await settled(e, { '21:list-1': 840, '22:general': 100, '24:general': 300 }, []);
      await views(readers, [22, 24], [], { 22: 1.6, 24: 5 });
      const current = await e.state();
      const [response] = await Promise.all([
        send(a, 'rules:update', move(current, 21, 'list-1', 'general')), popup.goto(e.popupUrl)
      ]);
      assert.equal(response.success, true, JSON.stringify(response));
      await settled(e, { '21:general': 840, '22:general': 100, '24:general': 300 }, [21]);
      await views(readers, [21, 22, 24], [21], { 21: 10, 22: 1.6, 24: 5 });
      await popup.goto(e.popupUrl);
      await views(readers, [21, 22, 24], [21], { 21: 10, 22: 1.6, 24: 5 });
      await settled(e, { '21:general': 840, '22:general': 100, '24:general': 300 }, [21]);
      await e.assertBlocked('http://usage.bd-e2e.test/moved', 'daily_limit');
    }
  },
  {
    id: '20', persistent: true,
    title: 'readers recover an expired day with a pending remap after restart and account only the new foreground segment',
    async run(e) {
      await e.seed({ rules: [rule(21)], usage: { '21:general': 840 } });
      const before = await e.openOptions();
      await e.reconcile(before);
      await settled(e, { '21:general': 840 }, [21]);
      const expired = await before.evaluate(() => {
        const day = new Date(); day.setDate(day.getDate() - 1);
        const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        return { date, timestamp: day.getTime() };
      });
      // Persist an expired fixture; Date, alarms, storage and visibility remain native.
      await e.writeLocal({ dailyRuleUsage: { version: 2, date: expired.date,
        usageSeconds: { '21:list-1': 840 }, lastSample: {
          timestamp: expired.timestamp, assignmentKeys: ['21:list-1']
        } }, pendingDailyUsageRemaps: [
        { oldRuleId: 21, oldListId: 'list-1', newRuleId: 21, newListId: 'general' }
      ] });
      const durable = await e.state();
      assert.equal(durable.dailyRuleUsage.date, expired.date);
      assert.deepEqual(durable.dailyRuleUsage.usageSeconds, { '21:list-1': 840 });
      assert.equal(durable.pendingDailyUsageRemaps.length, 1);
      await e.restart();
      const a = await e.openOptions(); const b = await e.openOptions();
      const popup = await e.openPopup(); const readers = [a, b, popup];
      const today = await a.evaluate(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      });
      await eventually(async () => (await e.state()).dailyRuleUsage.date, today, 'native local day');
      await settled(e, {}, []);
      await views(readers, [21], [], { 21: 0 });
      await popup.goto(e.popupUrl);
      await views(readers, [21], [], { 21: 0 });
      await settled(e, {}, []);
      const foreground = await e.newPage('http://usage.bd-e2e.test/new-day');
      if (foreground.front) await foreground.front(); else await foreground.bringToFront();
      await eventually(() => foreground.evaluate(() => document.querySelector('h1')?.textContent),
        'BD E2E fixture', 'new-day navigation is permitted');
      await eventually(() => foreground.evaluate(() => ({ visible: document.visibilityState, focused: document.hasFocus() })),
        { visible: 'visible', focused: true }, 'native visibility and document focus');
      const active = await a.evaluate(async () => {
        const api = globalThis.browser || chrome;
        const tabs = await api.tabs.query({ active: true, currentWindow: true });
        return tabs[0]?.url;
      });
      assert.equal(active, 'http://usage.bd-e2e.test/new-day', 'actual active browser tab');
      await eventually(async () => (await e.state()).dailyRuleUsage.lastSample?.assignmentKeys,
        ['21:general'], 'native foreground accounting started');
      await delay(2000);
      if (a.front) await a.front(); else await a.bringToFront();
      let charged;
      const started = Date.now();
      do {
        charged = (await e.state()).dailyRuleUsage.usageSeconds['21:general'];
        if (charged > 0) break;
        await delay(250);
      } while (Date.now() - started < 15_000);
      assert.ok(charged > 0 && charged < 10, `only the new foreground segment is charged: ${charged}`);
      await popup.goto(e.popupUrl);
      await views(readers, [21], [], { 21: Math.floor(charged / 6) / 10 });
      await settled(e, { '21:general': charged }, []);
    }
  }
];
