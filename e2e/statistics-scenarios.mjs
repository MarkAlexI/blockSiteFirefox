import assert from 'node:assert/strict';

const press = (page, key) => page.keyboard ? page.keyboard.press(key) : page.press(key);
const focus = (page, selector) => page.evaluate(selector => document.querySelector(selector).focus(), selector);
async function poll(read, check, label) {
  const deadline = Date.now() + 15_000;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const holdNextRead = page => page.evaluate(async () => {
  const api = typeof browser === 'undefined' ? chrome : browser;
  const { StatisticsManager } = await import(api.runtime.getURL('pro/statisticsManager.js'));
  const original = StatisticsManager.getStatistics;
  const gate = window.__bdStatisticsGate = { started: false, original, release: null };
  StatisticsManager.getStatistics = async function(options) {
    const stats = await original.call(this, options);
    if (!gate.started) { gate.started = true; await new Promise(resolve => { gate.release = resolve; }); }
    return stats;
  };
});
const releaseRead = page => page.evaluate(async () => {
  const api = typeof browser === 'undefined' ? chrome : browser;
  const { StatisticsManager } = await import(api.runtime.getURL('pro/statisticsManager.js'));
  const gate = window.__bdStatisticsGate;
  StatisticsManager.getStatistics = gate.original; gate.release();
  await new Promise(resolve => setTimeout(resolve, 0));
});

export const statisticsScenarios = [{
  id: '60',
  title: 'Statistics retains independent dates and native keyboard focus through storage refresh, range changes and delayed reads',
  async run(e) {
    const page = await e.openOptions();
    await focus(page, '[aria-controls="statistics-panel"]'); await press(page, 'Enter');
    const writeStatistics = value => page.evaluate(async value => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const now = new Date(), history = {};
      for (let offset = 0; offset < 30; offset++) {
        const date = new Date(now); date.setDate(date.getDate() - offset);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        history[key] = { blocked: offset === 0 ? value : 1, redirected: 0, focusSessions: offset % 3 === 0 ? 1 : 0 };
      }
      await api.storage.local.set({ statistics: { totalBlocked: value + 29, blockedToday: value,
        totalRedirects: 0, redirectsToday: 0, successfulFocusSessions: 10,
        creationDate: now.toDateString(), lastResetDate: now.toDateString(), dailyHistory: history } });
    }, value);
    const snapshot = () => page.evaluate(() => {
      const chart = id => {
        const root = document.getElementById(id), selected = root.querySelector('[aria-checked="true"]');
        return { date: selected?.dataset.statsDate, count: root.querySelectorAll('[role="radio"]').length,
          checked: root.querySelectorAll('[aria-checked="true"]').length,
          tabStops: [...root.querySelectorAll('[role="radio"]')].filter(button => button.tabIndex === 0).length };
      };
      return { activity: chart('statsActivityChart'), focus: chart('statsFocusChart'),
        activeDate: document.activeElement.dataset.statsDate || null,
        activeId: document.activeElement.id,
        activeChart: document.activeElement.closest('.stats-chart')?.id || null,
        total: document.getElementById('totalBlocked').textContent,
        rangeTotal: document.getElementById('statsBlockedRangeTotal').textContent,
        range: document.querySelector('[data-stat-range][aria-pressed="true"]')?.dataset.statRange,
        status: document.getElementById('statisticsStatus').textContent };
    });
    await writeStatistics(10);
    await poll(snapshot, s => s.total === '39' && s.activity.count === 30, 'initial native Statistics view');
    const rangeName = await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      return api.i18n.getMessage('statisticsrange');
    });
    if (page.getByRole) assert.equal(await page.getByRole('group', { name: rangeName, exact: true }).count(), 1);
    else assert.equal(await (await page.element('.stats-range-toggle')).getAccessibleName(), rangeName);

    // Enter both graphs through native Tab stops and use real radio keys.
    await focus(page, '[data-stat-range="30"]'); await press(page, 'Tab');
    await press(page, 'ArrowLeft'); await press(page, 'ArrowLeft');
    assert.equal((await snapshot()).activeChart, 'statsActivityChart');
    await press(page, 'Tab'); await press(page, 'Home');
    assert.equal((await snapshot()).activeChart, 'statsFocusChart');
    await press(page, 'Shift+Tab');
    const chosen = await snapshot();
    assert.equal(chosen.activeDate, chosen.activity.date);
    await writeStatistics(20);
    const refreshed = await poll(snapshot, s => s.total === '49' && s.activeChart === 'statsActivityChart' &&
      s.activeDate === chosen.activity.date, 'focused native radio survives refresh');
    assert.equal(refreshed.activity.date, chosen.activity.date);
    assert.equal(refreshed.focus.date, chosen.focus.date);
    assert.deepEqual([refreshed.activity.checked, refreshed.activity.tabStops, refreshed.focus.checked, refreshed.focus.tabStops], [1, 1, 1, 1]);

    // The snapshot comes from real storage. Gate only its delivery to the UI.
    await holdNextRead(page); await writeStatistics(30);
    await poll(() => page.evaluate(() => !!window.__bdStatisticsGate.release), Boolean, 'held Statistics read');
    await focus(page, '#search-input');
    if (page.locator) await page.locator('#search-input').fill('stats-draft');
    else await page.fill('#search-input', 'stats-draft');
    await releaseRead(page);
    const laterChoice = await poll(snapshot, s => s.total === '59', 'held read completes');
    assert.equal(laterChoice.activeId, 'search-input', 'later input focus takes priority');
    assert.equal(laterChoice.activity.date, chosen.activity.date);
    assert.equal(await page.evaluate(() => document.getElementById('search-input').value), 'stats-draft');

    await focus(page, '[data-stat-range="7"]'); await press(page, 'Enter');
    const narrowed = await poll(snapshot, s => s.range === '7' && s.activity.count === 7, 'native seven-day range');
    assert.equal(narrowed.activity.date, chosen.activity.date);
    assert.notEqual(narrowed.focus.date, chosen.focus.date);
    assert.equal(await page.evaluate(() => document.querySelector('#statsFocusChart [role="radio"]').dataset.statsDate), narrowed.focus.date,
      'the oldest visible date replaces a selection outside the window');
    assert.equal(narrowed.activeChart, null);

    await holdNextRead(page); await writeStatistics(40);
    await poll(() => page.evaluate(() => !!window.__bdStatisticsGate.release), Boolean, 'older snapshot held');
    await writeStatistics(50);
    await focus(page, '[data-stat-range="30"]'); await press(page, 'Enter');
    await poll(snapshot, s => s.total === '79' && s.range === '30' && s.activity.count === 30, 'newest coherent range');
    await releaseRead(page);
    const newest = await snapshot();
    assert.deepEqual([newest.total, newest.rangeTotal, newest.range, newest.activity.count], ['79', '79', '30', 30]);

    await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const { StatisticsManager } = await import(api.runtime.getURL('pro/statisticsManager.js'));
      window.__bdStatisticsOriginal = StatisticsManager.getStatistics;
      StatisticsManager.getStatistics = async () => { throw new Error('private statistics UI fixture'); };
    });
    await writeStatistics(60);
    const failed = await poll(snapshot, s => s.status.length > 0, 'safe persistent read failure');
    assert.equal(failed.total, '79');
    assert.equal(failed.status, await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      return api.i18n.getMessage('statisticsloadfailed');
    }));
    await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const { StatisticsManager } = await import(api.runtime.getURL('pro/statisticsManager.js'));
      StatisticsManager.getStatistics = window.__bdStatisticsOriginal;
    });
    await focus(page, '[data-stat-range="7"]'); await press(page, 'Enter');
    const recovered = await poll(snapshot, s => s.total === '89' && s.range === '7' && !s.status, 'range retry recovers');
    const evidence = { chosen, refreshed, laterChoice, narrowed, newest, failed, recovered,
      note: 'Native extension pages and keyboard input with scoped delivery/error fixtures. No screen-reader speech or OS lifecycle claim.' };
    if (e.result) e.result.statisticsRefresh = evidence;
    if (e.testInfo) await e.testInfo.attach('statistics-refresh', { contentType: 'application/json', body: JSON.stringify(evidence) });
  }
}];
