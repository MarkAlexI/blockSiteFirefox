import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('current-state diagnostics are visible to all users while Debug Mode remains Pro', async () => {
  const html = await readFile(path.join(root, 'options/options.html'), 'utf8');
  const debugSection = html.match(/<section class="([^"]*)">\s*<h2[^>]*data-i18n="debugsettingstitle"[\s\S]*?<\/section>/)?.[1] || '';
  const diagnosticsSection = html.match(/<section class="([^"]*)">\s*<h2[^>]*data-i18n="diagnosticstitle"[\s\S]*?<\/section>/)?.[1] || '';

  assert.match(debugSection, /pro-feature/);
  assert.doesNotMatch(diagnosticsSection, /pro-feature/);
  assert.doesNotMatch(diagnosticsSection, /hidden/);
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
