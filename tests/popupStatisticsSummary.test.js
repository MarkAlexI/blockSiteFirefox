import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('popup exposes a privacy-safe Blocked Today summary to every user', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles/popup.css', import.meta.url), 'utf8');
  const source = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
  const header = html.match(/<div id="header">([\s\S]*?)<\/div>\s*<div id="motivational-quote">/)?.[1] || '';

  assert.match(header, /id="blocking-summary" class="blocking-summary" aria-live="polite"/);
  assert.match(header, /data-i18n="blockedtodaylabel"/);
  assert.match(header, /id="popup-blocked-today">0<\/strong>/);
  assert.doesNotMatch(header, /pro-feature/);
  assert.match(css, /\.blocking-summary\s*\{/);
  assert.match(source, /import \{ StatisticsManager \} from '\.\/pro\/statisticsManager\.js';/);
  assert.match(source, /await this\.loadStatisticsSummary\(\);\s*await this\.loadRules\(\);/);
  assert.match(source, /changes\?\.statistics/);
  assert.match(source, /Number\.isFinite\(value\) && value > 0 \? Math\.floor\(value\) : 0/);
});
