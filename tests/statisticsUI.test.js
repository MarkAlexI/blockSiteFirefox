import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Statistics stays collapsed by default and exposes 7/30 day local charts', async () => {
  const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../options/settings.js', import.meta.url), 'utf8');
  const charts = await readFile(new URL('../options/statisticsCharts.js', import.meta.url), 'utf8');

  assert.match(html, /setting-section hidden pro-feature collapsible-section/);
  assert.doesNotMatch(html, /setting-section hidden pro-feature collapsible-section expanded[^>]*>\s*<h2[^>]*statisticstitle/);
  assert.match(html, /data-stat-range="7"/);
  assert.match(html, /data-stat-range="30"/);
  assert.match(html, /id="statsActivityChart"/);
  assert.match(html, /id="statsFocusChart"/);
  assert.match(html, /id="statsBlockedRangeTotal"/);
  assert.match(html, /id="statsRedirectedRangeTotal"/);
  assert.match(html, /id="statsFocusRangeTotal"/);
  assert.match(settings, /statisticsRangeDays = 30/);
  assert.equal((settings.match(/statisticsRangeDays = 30/g) || []).length, 1);
  assert.match(settings, /renderStatisticsCharts/);
  assert.match(charts, /buildStatisticsSeries/);
  assert.doesNotMatch(charts, /https?:\/\//);
});

test('30-day Statistics axis shows month only at the start and when the month changes', async () => {
  const { buildDateTickPlan } = await import('../options/statisticsCharts.js');
  const series = [];
  const start = new Date(2026, 6, 20);

  for (let index = 0; index < 30; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    series.push({ date });
  }

  const ticks = buildDateTickPlan(series);
  assert.deepEqual(
    ticks.map(({ index, includeMonth }) => ({ index, includeMonth })),
    [
      { index: 0, includeMonth: true },
      { index: 5, includeMonth: false },
      { index: 10, includeMonth: false },
      { index: 15, includeMonth: true },
      { index: 20, includeMonth: false },
      { index: 25, includeMonth: false },
      { index: 29, includeMonth: false }
    ]
  );
});

test('7-day Statistics axis keeps the month on every visible date', async () => {
  const { buildDateTickPlan } = await import('../options/statisticsCharts.js');
  const series = Array.from({ length: 7 }, (_, index) => ({
    date: new Date(2026, 7, 12 + index)
  }));

  const ticks = buildDateTickPlan(series);
  assert.equal(ticks.length, 7);
  assert.equal(ticks.every(tick => tick.includeMonth), true);
});


test('Statistics chart scale uses readable whole-number ticks', async () => {
  const { buildChartScale } = await import('../options/statisticsCharts.js');
  const definitions = [{ key: 'blocked' }];

  assert.deepEqual(
    buildChartScale([{ blocked: 17 }], definitions),
    { maximum: 20, ticks: [20, 15, 10, 5, 0] }
  );
  assert.deepEqual(
    buildChartScale([{ blocked: 7 }], definitions),
    { maximum: 8, ticks: [8, 6, 4, 2, 0] }
  );
  assert.deepEqual(
    buildChartScale([{ blocked: 0 }], definitions),
    { maximum: 1, ticks: [1, 0] }
  );
});

test('Statistics range summaries add the selected daily series only', async () => {
  const { summarizeStatisticsSeries } = await import('../options/statisticsCharts.js');

  assert.deepEqual(summarizeStatisticsSeries([
    { blocked: 3, redirected: 1, focusSessions: 0 },
    { blocked: 5, redirected: 2, focusSessions: 1 },
    { blocked: 0, redirected: 4, focusSessions: 2 }
  ]), {
    blocked: 8,
    redirected: 7,
    focusSessions: 3
  });
});

test('Statistics charts expose mobile-friendly daily details and keyboard navigation', async () => {
  const charts = await readFile(new URL('../options/statisticsCharts.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles/options.css', import.meta.url), 'utf8');

  assert.match(charts, /stats-chart-y-axis/);
  assert.match(charts, /stats-chart-detail/);
  assert.match(charts, /mouseenter/);
  assert.match(charts, /ArrowLeft/);
  assert.match(charts, /ArrowRight/);
  assert.match(css, /stats-chart-y-axis/);
  assert.match(css, /stats-chart-detail/);
});
