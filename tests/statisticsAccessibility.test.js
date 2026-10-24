import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDefaultStatistics, getLocalDateKey } from '../pro/statisticsHistory.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function statistics(value) {
  return { ...createDefaultStatistics(), totalBlocked: value, blockedToday: value,
    dailyHistory: { [getLocalDateKey()]: { blocked: value, redirected: 0, focusSessions: 0 } } };
}

async function withUI(t, run) {
  const document = new FakeDocument();
  const panel = document.addElement('statistics-panel');
  const status = document.addElement('statisticsStatus'); panel.append(status);
  for (const id of ['totalBlocked', 'blockedToday', 'totalRedirects', 'redirectsToday',
    'successfulFocusSessions', 'statsBlockedRangeTotal', 'statsRedirectedRangeTotal',
    'statsFocusRangeTotal', 'statsActivityChart', 'statsFocusChart', 'clearStatistics']) {
    const element = document.addElement(id, id === 'clearStatistics' ? 'button' : 'div');
    element.textContent = '-'; panel.append(element);
  }
  for (const id of ['exportRules', 'importRules', 'clearAllRules', 'resetSettings']) document.addElement(id, 'button');
  document.addElement('importFileInput', 'input');
  const search = document.addElement('search-input', 'input');
  for (const days of [7, 30]) {
    const button = document.addElement('range-' + days, 'button');
    button.dataset.statRange = String(days); panel.append(button);
  }
  const api = createExtensionApi({ local: { statistics: statistics(10) },
    sync: { credentials: { isPro: true, installationDate: '2026-08-01T00:00:00.000Z' } } });
  const oldConfirm = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  let confirmations = 0, confirmed = true;
  globalThis.confirm = () => { confirmations++; return confirmed; };
  try {
    await withExtensionEnvironment(api, async () => {
      const { SettingsManager } = await import('../options/settings.js');
      const { StatisticsManager } = await import('../pro/statisticsManager.js');
      const { ProManager } = await import('../pro/proManager.js');
      t.mock.method(StatisticsManager.logger, 'error', () => {});
      const manager = Object.create(SettingsManager.prototype);
      manager.logger = { log() {}, error() {} };
      manager.statisticsRangeDays = 30;
      manager.setupEventListeners();
      await run({ document, panel, status, search, api, manager, StatisticsManager, ProManager,
        confirmations: () => confirmations, confirm: value => { confirmed = value; } });
    }, { document });
  } finally {
    if (oldConfirm) Object.defineProperty(globalThis, 'confirm', oldConfirm);
    else delete globalThis.confirm;
  }
}

test('Statistics has a localized range-group name and a persistent polite atomic status region', async () => {
  const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
  assert.match(html, /class="stats-range-toggle"[^>]*role="group"[^>]*data-i18n-aria-label="statisticsrange"/);
  assert.match(html, /id="statisticsStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*><\/p>/);
});

test('only the latest read commits a coherent range, totals, charts and pressed state', async t => {
  await withUI(t, async ({ manager, document, StatisticsManager, panel }) => {
    await manager.loadStatistics();
    const old = deferred(), latest = deferred();
    let reads = 0;
    t.mock.method(StatisticsManager, 'getStatistics', () => (++reads === 1 ? old : latest).promise);
    const first = document.getElementById('range-7').dispatch('click');
    assert.equal(document.getElementById('range-30').getAttribute('aria-pressed'), 'true', 'keep the committed view while reading');
    const second = document.getElementById('range-30').dispatch('click');
    latest.resolve(statistics(22)); await second;
    old.resolve(statistics(11)); await first;
    assert.equal(document.getElementById('totalBlocked').textContent, 22);
    assert.equal(document.getElementById('statsBlockedRangeTotal').textContent, 22);
    assert.equal(document.getElementById('statsActivityChart').querySelectorAll('[role="radio"]').length, 30);
    assert.equal(document.getElementById('range-30').getAttribute('aria-pressed'), 'true');
    assert.equal(panel.getAttribute('aria-busy'), 'false');
  });
});

test('a stale read error cannot replace a newer successful view or announce an obsolete failure', async t => {
  await withUI(t, async ({ manager, document, status, StatisticsManager }) => {
    const old = deferred(); let reads = 0;
    t.mock.method(StatisticsManager, 'getStatistics', () => ++reads === 1 ? old.promise : Promise.resolve(statistics(24)));
    const first = manager.loadStatistics(); await manager.loadStatistics();
    old.reject(new Error('private old storage message')); await first;
    assert.equal(document.getElementById('totalBlocked').textContent, 24);
    assert.equal(status.textContent, '');
  });
});

test('a storage refresh during a range request keeps the latest requested range', async t => {
  await withUI(t, async ({ manager, document, StatisticsManager }) => {
    const first = deferred(); let reads = 0;
    t.mock.method(StatisticsManager, 'getStatistics', () => ++reads === 1 ? first.promise : Promise.resolve(statistics(42)));
    const changing = document.getElementById('range-7').dispatch('click');
    await manager.loadStatistics();
    first.resolve(statistics(10)); await changing;
    assert.equal(document.getElementById('statsActivityChart').querySelectorAll('[role="radio"]').length, 7);
    assert.equal(document.getElementById('range-7').getAttribute('aria-pressed'), 'true');
    assert.equal(document.getElementById('totalBlocked').textContent, 42);
  });
});

test('failed reads retain the last correct values, graph and range, then recover on an explicit range retry', async t => {
  await withUI(t, async ({ manager, document, status, api, search }) => {
    await manager.loadStatistics(); search.focus();
    const graph = document.getElementById('statsActivityChart').children[0];
    api.storage.local.getError = new Error('private.storage.example/secret');
    await document.getElementById('range-7').dispatch('click');
    assert.equal(document.getElementById('totalBlocked').textContent, 10);
    assert.equal(document.getElementById('statsActivityChart').children[0], graph);
    assert.equal(document.getElementById('range-30').getAttribute('aria-pressed'), 'true');
    assert.equal(status.textContent, 'statisticsloadfailed');
    assert.equal(status.classList.contains('error'), true);
    assert.equal(document.activeElement, search);
    api.storage.local.getError = null;
    await document.getElementById('range-7').dispatch('click');
    assert.equal(document.getElementById('range-7').getAttribute('aria-pressed'), 'true');
    assert.equal(status.textContent, '');
  });
});

test('an initial storage failure is distinct from a genuine empty history', async t => {
  await withUI(t, async ({ manager, document, status, api }) => {
    api.storage.local.getError = new Error('read failed');
    await manager.loadStatistics();
    assert.equal(document.getElementById('totalBlocked').textContent, '-');
    assert.equal(document.getElementById('statsActivityChart').children.length, 0);
    assert.equal(status.textContent, 'statisticsloadfailed');
    api.storage.local.getError = null; delete api.storage.local.data.statistics;
    await manager.loadStatistics();
    assert.equal(document.getElementById('totalBlocked').textContent, 0);
    assert.equal(status.textContent, '');
  });
});

test('a choice made while a read is pending determines selection and focus at commit', async t => {
  await withUI(t, async ({ manager, document, StatisticsManager, search }) => {
    await manager.loadStatistics();
    const gate = deferred(); t.mock.method(StatisticsManager, 'getStatistics', () => gate.promise);
    const reading = manager.loadStatistics();
    const old = document.getElementById('statsActivityChart').querySelectorAll('[role="radio"]')[12]; old.focus();
    const key = old.dataset.statsDate;
    search.focus(); gate.resolve(statistics(50)); await reading;
    assert.equal(document.activeElement, search);
    assert.equal(document.getElementById('statsActivityChart').querySelector('[aria-checked="true"]').dataset.statsDate, key);
  });
});

for (const stage of ['Pro check', 'password check', 'reset']) {
  test('repeated clear requests are guarded during ' + stage, async t => {
    await withUI(t, async ({ manager, document, StatisticsManager, ProManager, confirmations }) => {
      const gate = deferred(); let pro = 0, passwords = 0, resets = 0;
      t.mock.method(ProManager, 'hasPaidAccess', async () => { pro++; return stage === 'Pro check' ? gate.promise : true; });
      manager.checkPasswordProtection = async () => { passwords++; return stage === 'password check' ? gate.promise : true; };
      t.mock.method(StatisticsManager, 'reset', async options => { assert.deepEqual(options, { throwOnError: true }); resets++; if (stage === 'reset') await gate.promise; });
      const button = document.getElementById('clearStatistics'); button.focus();
      const first = manager.clearStatistics();
      await Promise.resolve(); await Promise.resolve();
      assert.equal(await manager.clearStatistics(), false);
      assert.equal(button.getAttribute('aria-disabled'), 'true');
      gate.resolve(true); assert.equal(await first, true);
      assert.deepEqual([pro, passwords, resets, confirmations()], [1, 1, 1, 1]);
      assert.equal(document.activeElement, button);
      assert.equal(button.getAttribute('aria-disabled'), null);
    });
  });
}

test('cancelled clear authorization or confirmation allows a later explicit attempt without any reset', async t => {
  await withUI(t, async ({ manager, StatisticsManager, confirm }) => {
    let resets = 0; t.mock.method(StatisticsManager, 'reset', async () => { resets++; });
    manager.checkPasswordProtection = async () => false;
    assert.equal(await manager.clearStatistics(), false);
    manager.checkPasswordProtection = async () => true; confirm(false);
    assert.equal(await manager.clearStatistics(), false);
    assert.equal(resets, 0);
    confirm(true); assert.equal(await manager.clearStatistics(), true);
    assert.equal(resets, 1);
  });
});

test('Free clear requests preserve stored statistics and report the existing Pro requirement', async t => {
  await withUI(t, async ({ manager, status, api }) => {
    api.storage.sync.data.credentials = { isPro: false, installationDate: '2026-08-01T00:00:00.000Z' };
    assert.equal(await manager.clearStatistics(), false);
    assert.equal(api.storage.local.data.statistics.totalBlocked, 10);
    assert.equal(status.textContent, 'prorequired');
  });
});

test('a failed reset keeps the displayed data, reports no success and permits a genuine retry', async t => {
  await withUI(t, async ({ manager, document, status, api, search, panel }) => {
    await manager.loadStatistics(); search.focus();
    api.storage.local.setError = new Error('private write failure');
    assert.equal(await manager.clearStatistics(), false);
    assert.equal(document.getElementById('totalBlocked').textContent, 10);
    assert.equal(status.textContent, 'statisticsclearfailed');
    assert.equal(document.activeElement, search);
    assert.equal(panel.getAttribute('aria-busy'), 'false');
    api.storage.local.setError = null;
    assert.equal(await manager.clearStatistics(), true);
    assert.equal(document.getElementById('totalBlocked').textContent, 0);
    assert.equal(status.textContent, 'statscleared');
  });
});

test('clearing invalidates older reads even when reset fails and no follow-up read is made', async t => {
  await withUI(t, async ({ manager, document, status, StatisticsManager, panel }) => {
    await manager.loadStatistics();
    const old = deferred(); t.mock.method(StatisticsManager, 'getStatistics', () => old.promise);
    const reading = manager.loadStatistics();
    t.mock.method(StatisticsManager, 'reset', async () => { throw new Error('write failed'); });
    assert.equal(await manager.clearStatistics(), false);
    old.resolve(statistics(99)); await reading;
    assert.equal(document.getElementById('totalBlocked').textContent, 10);
    assert.equal(status.textContent, 'statisticsclearfailed');
    assert.equal(panel.getAttribute('aria-busy'), 'false');
  });
});

test('successful clearing followed by a read failure reports both facts while retaining the last view', async t => {
  await withUI(t, async ({ manager, document, status, StatisticsManager, api }) => {
    await manager.loadStatistics();
    const reset = StatisticsManager.reset.bind(StatisticsManager);
    t.mock.method(StatisticsManager, 'reset', async options => { await reset(options); api.storage.local.getError = new Error('read after write failed'); });
    assert.equal(await manager.clearStatistics(), true);
    assert.equal(api.storage.local.data.statistics.totalBlocked, 0);
    assert.equal(document.getElementById('totalBlocked').textContent, 10);
    assert.equal(status.textContent, 'statscleared statisticsloadfailed');
  });
});

test('clear completion respects a later focus choice and retains a newly chosen range', async t => {
  await withUI(t, async ({ manager, document, search, StatisticsManager }) => {
    await manager.loadStatistics();
    const gate = deferred(); const reset = StatisticsManager.reset.bind(StatisticsManager);
    t.mock.method(StatisticsManager, 'reset', async options => { await gate.promise; await reset(options); });
    const clearing = manager.clearStatistics();
    await document.getElementById('range-7').dispatch('click'); search.focus();
    gate.resolve(); await clearing;
    assert.equal(document.activeElement, search);
    assert.equal(document.getElementById('range-7').getAttribute('aria-pressed'), 'true');
    assert.equal(document.getElementById('statsActivityChart').querySelectorAll('[role="radio"]').length, 7);
  });
});
