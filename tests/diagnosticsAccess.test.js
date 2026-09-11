import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('current-state diagnostics remain available to all users while Debug Mode stays Pro', async () => {
  const html = await readFile(path.join(root, 'options/options.html'), 'utf8');
  const debugItem = html.match(/<div class="([^"]*setting-item[^"]*)">\s*<div class="setting-info">\s*<label for="enableDebug"/)?.[1] || '';
  const diagnosticsPanel = html.match(/<div class="([^"]*diagnostics-panel[^"]*)">/)?.[1] || '';

  assert.match(debugItem, /pro-feature/);
  assert.match(debugItem, /hidden/);
  assert.doesNotMatch(diagnosticsPanel, /pro-feature/);
  assert.doesNotMatch(diagnosticsPanel, /hidden/);
  const localizationAttribute = `data-${'i18n'}`;
  assert.doesNotMatch(
    html,
    new RegExp(`${localizationAttribute}="(?:debugsettingstitle|diagnosticstitle)" class="collapsible-header"`)
  );
});

test('Options uses five compact sections and a shared return link', async () => {
  const html = await readFile(path.join(root, 'options/options.html'), 'utf8');
  const css = await readFile(path.join(root, 'styles/options.css'), 'utf8');
  const sectionTitles = [
    'securitymodetitle',
    'basicsettingstitle',
    'privacysettingstitle',
    'rulesmanagementtitle',
    'statisticstitle'
  ];

  assert.equal(
    (html.match(/<section[^>]*class="[^"]*setting-section[^"]*collapsible-section[^"]*"/g) || []).length,
    sectionTitles.length
  );
  for (const key of sectionTitles) {
    assert.match(html, new RegExp(`<h2 data-${'i18n'}="${key}" class="collapsible-header">`));
  }
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<nav class="options-navigation"[\s\S]*?<a href="\.\.\/index\.html" class="footer-btn options-back-link" data-i18n="backtopopup">/);
  assert.doesNotMatch(html, /options-back-link[^>]*(?:pro-feature|hidden)/);
  assert.match(html, /id="resetSettings" class="footer-btn hidden pro-feature"/);
  assert.match(css, /\.setting-section:not\(\.expanded\) \.collapsible-header/);
});

test('Statistics is a collapsed Pro section by default', async () => {
  const html = await readFile(path.join(root, 'options/options.html'), 'utf8');
  const match = html.match(/<section class="([^"]*)">\s*<h2[^>]*data-i18n="statisticstitle"[^>]*class="([^"]*)"[^>]*>[\s\S]*?<div class="([^"]*collapsible-content[^"]*)">/);

  assert.ok(match, 'Statistics section should use the collapsible markup');
  assert.match(match[1], /pro-feature/);
  assert.match(match[1], /collapsible-section/);
  assert.doesNotMatch(match[1], /(?:^|\s)expanded(?:\s|$)/);
  assert.match(match[2], /collapsible-header/);
  assert.match(match[3], /stats-grid/);
});
