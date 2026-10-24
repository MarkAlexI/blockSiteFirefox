import test from 'node:test';
import assert from 'node:assert/strict';

import { renderStatisticsCharts } from '../options/statisticsCharts.js';
import { getLocalDateKey } from '../pro/statisticsHistory.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

function createChartFixture(days = 7) {
  const document = new FakeDocument();
  const activityContainer = document.addElement('activity');
  const focusContainer = document.addElement('focus');
  const now = new Date(2026, 7, 20, 12, 0, 0);
  const previous = new Date(now);
  previous.setDate(previous.getDate() - 1);

  const options = {
    stats: {
      lastResetDate: now.toDateString(),
      dailyHistory: {
        [getLocalDateKey(previous)]: { blocked: 3, redirected: 1, focusSessions: 2 },
        [getLocalDateKey(now)]: { blocked: 5, redirected: 2, focusSessions: 1 }
      }
    },
    days,
    activityContainer,
    focusContainer,
    labels: { blocked: 'Blocked', redirected: 'Redirected', focus: 'Focus' },
    now
  };

  return { document, activityContainer, focusContainer, options };
}

test('statistics charts render exact totals, accessible columns, bars, and numeric Y-axis labels', async () => {
  const { document, activityContainer, focusContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), () => {
    const result = renderStatisticsCharts(options);
    assert.equal(result.series.length, 7);
    assert.deepEqual(result.totals, { blocked: 8, redirected: 3, focusSessions: 3 });

    const columns = activityContainer.querySelectorAll('.stats-chart-column');
    assert.equal(columns.length, 7);
    assert.equal(columns.at(-1).tagName, 'BUTTON');
    assert.equal(columns.at(-1).type, 'button');
    assert.equal(columns.at(-1).getAttribute('role'), 'radio');
    assert.equal(activityContainer.querySelector('.stats-chart-plot').getAttribute('role'), 'radiogroup');
    assert.equal(activityContainer.querySelector('.stats-chart-plot').getAttribute('aria-label'), 'Blocked / Redirected');
    assert.equal(columns.at(-1).getAttribute('aria-checked'), 'true');
    assert.equal(columns.at(-1).tabIndex, 0);
    assert.match(columns.at(-1).getAttribute('aria-label'), /Blocked: 5/);
    assert.deepEqual(
      activityContainer.querySelectorAll('.stats-chart-y-tick').map(tick => tick.textContent),
      ['5', '4', '3', '2', '1', '0']
    );

    const bars = columns.at(-1).querySelectorAll('.stats-chart-bar');
    assert.equal(bars[0].style.height, '100%');
    assert.equal(bars[1].style.height, '40%');
    assert.equal(focusContainer.querySelectorAll('.stats-chart-column').length, 7);
  }, { document });
});

test('statistics charts mark zero-value bars and retain the latest day as the initial selection', async () => {
  const { document, activityContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), () => {
    renderStatisticsCharts(options);
    const columns = activityContainer.querySelectorAll('.stats-chart-column');
    const zeroBars = columns[0].querySelectorAll('.stats-chart-bar');
    assert.equal(zeroBars[0].dataset.zero, 'true');
    assert.equal(zeroBars[0].style.height, '0%');
    assert.equal(columns.at(-1).dataset.selected, 'true');
    assert.equal(columns[0].dataset.selected, 'false');
    assert.match(activityContainer.querySelector('.stats-chart-detail').textContent, /Blocked: 5/);
  }, { document });
});

test('hover shows exact daily values and leaving the plot restores the selected day', async () => {
  const { document, activityContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    const columns = activityContainer.querySelectorAll('.stats-chart-column');
    const detail = activityContainer.querySelector('.stats-chart-detail');

    await columns.at(-2).dispatch('mouseenter');
    assert.match(detail.textContent, /Blocked: 3/);
    assert.match(detail.textContent, /Redirected: 1/);

    await activityContainer.querySelector('.stats-chart-plot').dispatch('mouseleave');
    assert.match(detail.textContent, /Blocked: 5/);
  }, { document });
});

test('click and focus keep exactly one chart day selected and keyboard-accessible', async () => {
  const { document, activityContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    const columns = activityContainer.querySelectorAll('.stats-chart-column');

    await columns[1].dispatch('click');
    assert.equal(columns[1].dataset.selected, 'true');
    assert.equal(columns[1].tabIndex, 0);
    assert.equal(columns.at(-1).getAttribute('aria-checked'), 'false');
    assert.equal(columns.at(-1).tabIndex, -1);

    await columns[4].dispatch('focus');
    assert.equal(columns[4].dataset.selected, 'true');
    assert.equal(columns[1].dataset.selected, 'false');
  }, { document });
});

test('chart radio arrows wrap within their group and Home/End reach chronological endpoints', async () => {
  const { document, activityContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    const columns = activityContainer.querySelectorAll('.stats-chart-column');

    let event = await columns[6].dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(event.defaultPrevented, true);
    assert.equal(columns[5].dataset.selected, 'true');
    assert.equal(columns[5].focusCount, 1);

    event = await columns[5].dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(event.defaultPrevented, true);
    assert.equal(columns[6].dataset.selected, 'true');

    await columns[6].dispatch('keydown', { key: 'Home' });
    assert.equal(columns[0].dataset.selected, 'true');
    await columns[0].dispatch('keydown', { key: 'End' });
    assert.equal(columns[6].dataset.selected, 'true');

    event = await columns[0].dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(event.defaultPrevented, true);
    assert.equal(document.activeElement, columns[6]);
    await columns[6].dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(document.activeElement, columns[0]);
    await columns[0].dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, columns[6]);
    event = await columns[0].dispatch('keydown', { key: 'Tab' });
    assert.equal(event.defaultPrevented, undefined);
  }, { document });
});

test('RTL chart arrows follow visual direction while Home/End retain chronological endpoints', async () => {
  const { document, activityContainer, options } = createChartFixture();
  document.defaultView = { getComputedStyle: () => ({ direction: 'rtl' }) };
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    const columns = activityContainer.querySelectorAll('.stats-chart-column');
    await columns[6].dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(document.activeElement, columns[5]);
    await columns[5].dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(document.activeElement, columns[6]);
    await columns[6].dispatch('keydown', { key: 'Home' });
    assert.equal(document.activeElement, columns[0]);
    await columns[0].dispatch('keydown', { key: 'End' });
    assert.equal(document.activeElement, columns[6]);
    assert.equal(columns.filter(column => column.tabIndex === 0).length, 1);
  }, { document });
});

test('native chart activation restores exact selected-day text after hover preview', async () => {
  const { document, activityContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    const columns = activityContainer.querySelectorAll('.stats-chart-column');
    await columns[5].dispatch('mouseenter');
    assert.match(activityContainer.querySelector('.stats-chart-detail').textContent, /Blocked: 3/);
    await columns[6].dispatch('click');
    assert.match(activityContainer.querySelector('.stats-chart-detail').textContent, /Blocked: 5/);
    assert.equal(columns[6].getAttribute('aria-checked'), 'true');
  }, { document });
});

test('thirty-day charts use compact labels with explicit start and end edge markers', async () => {
  const { document, activityContainer, options } = createChartFixture(30);
  await withExtensionEnvironment(createExtensionApi(), () => {
    renderStatisticsCharts(options);
    const ticks = activityContainer.querySelectorAll('.stats-chart-date');
    assert.ok(ticks.length < 30);
    assert.equal(ticks[0].dataset.edge, 'start');
    assert.equal(ticks.at(-1).dataset.edge, 'end');
    assert.equal(ticks.every(tick => tick.title.length > 0), true);
    assert.equal(activityContainer.querySelector('.stats-chart-plot').style['--stats-chart-columns'], '30');
  }, { document });
});

test('chart totals remain available when one or both chart containers are missing', async () => {
  const { document, focusContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), () => {
    const result = renderStatisticsCharts({ ...options, activityContainer: null });
    assert.deepEqual(result.totals, { blocked: 8, redirected: 3, focusSessions: 3 });
    assert.equal(focusContainer.querySelectorAll('.stats-chart-column').length, 7);

    const withoutContainers = renderStatisticsCharts({
      ...options,
      activityContainer: null,
      focusContainer: null
    });
    assert.equal(withoutContainers.series.length, 7);
  }, { document });
});

test('chart refresh retains independent selected dates and updates their exact values', async () => {
  const { document, activityContainer, focusContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    await activityContainer.querySelectorAll('.stats-chart-column')[5].dispatch('click');
    await focusContainer.querySelectorAll('.stats-chart-column')[2].dispatch('click');
    options.stats.dailyHistory[getLocalDateKey(new Date(2026, 7, 19))].blocked = 19;
    renderStatisticsCharts(options);
    assert.equal(activityContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-19');
    assert.equal(focusContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-16');
    assert.match(activityContainer.querySelector('.stats-chart-detail').textContent, /Blocked: 19/);
    assert.equal(activityContainer.querySelectorAll('.stats-chart-column').filter(button => button.tabIndex === 0).length, 1);
  }, { document });
});

test('refresh of a focused day restores its replacement radio without changing the selected date', async () => {
  const { document, activityContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), () => {
    renderStatisticsCharts(options);
    const old = activityContainer.querySelectorAll('.stats-chart-column')[3];
    old.focus();
    renderStatisticsCharts(options);
    assert.notEqual(document.activeElement, old);
    assert.equal(document.activeElement, activityContainer.querySelector('[aria-checked="true"]'));
    assert.equal(document.activeElement.dataset.statsDate, '2026-08-17');
  }, { document });
});

test('range changes preserve visible dates and clamp an older selection to the earliest remaining date', async () => {
  const { document, activityContainer, focusContainer, options } = createChartFixture(30);
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    await activityContainer.querySelectorAll('.stats-chart-column')[27].dispatch('click');
    await focusContainer.querySelectorAll('.stats-chart-column')[0].dispatch('click');
    const range = document.addElement('range', 'button'); range.focus();
    renderStatisticsCharts({ ...options, days: 7 });
    assert.equal(activityContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-18');
    assert.equal(focusContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-14');
    assert.equal(document.activeElement, range, 'changing range does not move focus into either graph');
    renderStatisticsCharts(options);
    assert.equal(focusContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-14');
  }, { document });
});

test('the next local day shifts positions while retaining a date and clamps an expired oldest day', async () => {
  const { document, activityContainer, focusContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    await activityContainer.querySelectorAll('.stats-chart-column')[5].dispatch('click');
    await focusContainer.querySelectorAll('.stats-chart-column')[0].dispatch('click');
    renderStatisticsCharts({ ...options, now: new Date(2026, 7, 21, 12) });
    assert.equal(activityContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-19');
    assert.equal(focusContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-15');
    renderStatisticsCharts({ ...options, now: new Date(2026, 7, 15, 12) });
    assert.equal(activityContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-15',
      'a date beyond a backwards-shifted window uses the latest visible boundary');
  }, { document });
});

for (const boundary of ['search', 'hidden document', 'unfocused window', 'hidden panel', 'inert panel', 'modal', 'Focus lock']) {
  test('chart refresh preserves selection without moving focus across ' + boundary, async () => {
    const { document, activityContainer, options } = createChartFixture();
    await withExtensionEnvironment(createExtensionApi(), () => {
      renderStatisticsCharts(options);
      const old = activityContainer.querySelectorAll('.stats-chart-column')[4]; old.focus();
      let expected = old;
      if (boundary === 'search') { expected = document.addElement('search', 'input'); expected.focus(); }
      if (boundary === 'hidden document') document.hidden = true;
      if (boundary === 'unfocused window') document.hasFocus = () => false;
      if (boundary === 'hidden panel') activityContainer.hidden = true;
      if (boundary === 'inert panel') activityContainer.inert = true;
      if (boundary === 'Focus lock') activityContainer.classList.add('focus-lock-active');
      if (boundary === 'modal') document.addElement('modal', 'dialog').setAttribute('open', '');
      renderStatisticsCharts(options);
      assert.equal(document.activeElement, expected);
      assert.equal(activityContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-18');
      assert.equal(activityContainer.querySelector('[aria-checked="true"]').focusCount, 0);
    }, { document });
  });
}

test('a synchronous focus choice during DOM replacement takes priority over chart restoration', async () => {
  const { document, activityContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), () => {
    renderStatisticsCharts(options);
    activityContainer.querySelectorAll('.stats-chart-column')[2].focus();
    const search = document.addElement('search', 'input');
    const replace = activityContainer.replaceChildren.bind(activityContainer);
    activityContainer.replaceChildren = (...children) => { replace(...children); search.focus(); };
    renderStatisticsCharts(options);
    assert.equal(document.activeElement, search);
    assert.equal(activityContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-16');
  }, { document });
});

test('a hover preview never replaces the retained selected date on refresh', async () => {
  const { document, activityContainer, options } = createChartFixture();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    renderStatisticsCharts(options);
    const columns = activityContainer.querySelectorAll('.stats-chart-column');
    await columns[4].dispatch('click'); await columns[5].dispatch('mouseenter');
    renderStatisticsCharts(options);
    assert.equal(activityContainer.querySelector('[aria-checked="true"]').dataset.statsDate, '2026-08-18');
    assert.match(activityContainer.querySelector('.stats-chart-detail').textContent, /Blocked: 0/);
  }, { document });
});
