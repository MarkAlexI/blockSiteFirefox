import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultExpectedVersion } from '../e2e/target-version.mjs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const dnrBootstrapRules = JSON.parse(
  readFileSync(new URL('../rules/dnrBootstrapRules.json', import.meta.url), 'utf8')
);

test('Firefox source metadata matches this release and CWS badge reads the published store version', () => {
  assert.equal(packageJson.version, manifest.version);
  assert.equal(changelog.match(/^## \[([^\]]+)\]/m)?.[1], manifest.version);
  assert.equal(readme.includes('img.shields.io/chrome-web-store/v/kfhgdgokgjmdboidlhphajinmgpcmmec'), true);
  assert.equal(readme.includes('Chrome%20Web%20Store-v'), false);
  assert.equal(readme.includes(`Firefox%20Source-v${manifest.version}-`), true);
  assert.equal(readme.includes('img.shields.io/amo/v/blockersite'), true);

  if (Object.hasOwn(manifest, 'version_name')) {
    assert.equal(manifest.version_name, manifest.version);
  }
});

test('E2E instructions and default target match the checked-out manifest', () => {
  const instructions = readFileSync(new URL('../e2e/README.md', import.meta.url), 'utf8');
  assert.equal(defaultExpectedVersion, manifest.version);
  assert.equal(instructions.includes(`**${manifest.version}**`), true);
  assert.equal(instructions.includes('5.3.6'), false);
  const runner = readFileSync(new URL('../e2e/runner.mjs', import.meta.url), 'utf8');
  assert.match(runner, /expectedVersion[,\n]/);
  assert.equal(runner.includes("|| '5.3."), false);
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
