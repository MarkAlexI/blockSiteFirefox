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
    assert.equal(columns.at(-1).getAttribute('role'), 'button');
    assert.equal(columns.at(-1).getAttribute('aria-pressed'), 'true');
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
    assert.equal(columns.at(-1).getAttribute('aria-pressed'), 'false');
    assert.equal(columns.at(-1).tabIndex, -1);

    await columns[4].dispatch('focus');
    assert.equal(columns[4].dataset.selected, 'true');
    assert.equal(columns[1].dataset.selected, 'false');
  }, { document });
});

test('keyboard arrows, Home, and End move selection without stepping outside the available days', async () => {
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
    assert.equal(event.defaultPrevented, undefined);
    event = await columns[0].dispatch('keydown', { key: 'Tab' });
    assert.equal(event.defaultPrevented, undefined);
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
