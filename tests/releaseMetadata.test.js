import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const dnrBootstrapRules = JSON.parse(
  readFileSync(new URL('../rules/dnrBootstrapRules.json', import.meta.url), 'utf8')
);

test('Firefox release metadata stays current without rewriting the published CWS badge', () => {
  assert.equal(packageJson.version, manifest.version);
  assert.equal(changelog.match(/^## \[([^\]]+)\]/m)?.[1], manifest.version);
  assert.equal(readme.includes('Chrome%20Web%20Store-v5.2.8-'), true);
  assert.equal(readme.includes('img.shields.io/amo/v/blockersite'), true);

  if (Object.hasOwn(manifest, 'version_name')) {
    assert.equal(manifest.version_name, manifest.version);
  }
});

test('Firefox DNR bootstrap ruleset remains enabled and intentionally empty', () => {
  assert.deepEqual(manifest.declarative_net_request?.rule_resources, [
    {
      id: 'dnr_bootstrap',
      enabled: true,
      path: 'rules/dnrBootstrapRules.json'
    }
  ]);
  assert.deepEqual(dnrBootstrapRules, []);
});
