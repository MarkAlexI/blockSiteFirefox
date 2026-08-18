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
