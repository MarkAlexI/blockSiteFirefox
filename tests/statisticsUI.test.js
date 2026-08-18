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
