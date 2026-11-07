import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityScenarioIds } from './scenario-groups.mjs';
import { expectedVersion } from './target-version.mjs';

export function verifyCompatibilityResult(report) {
  assert.equal(report.platform?.platform, 'linux', 'compatibility evidence must come from Linux');
  assert.equal(report.group, 'compatibility');
  assert.equal(report.status, 'passed');
  assert.equal(report.expectedVersion, expectedVersion, 'report must match this checkout');
  assert.ok(report.finishedAt, 'the runner must finish');
  assert.equal(report.selected, compatibilityScenarioIds.length);
  assert.deepEqual(report.tests.map(test => test.id).sort(), [...compatibilityScenarioIds].sort(),
    'all compatibility scenarios must execute exactly once');
  for (const test of report.tests) {
    assert.equal(test.status, 'passed', `scenario ${test.id} must pass`);
    assert.equal(test.bodyStarted, true, `scenario ${test.id} body must execute`);
    assert.equal(test.cleanupError, undefined, `scenario ${test.id} cleanup must succeed`);
    assert.equal(test.browser?.browserName, 'firefox');
    assert.equal(test.browser?.browserVersion, '128.0', 'a current Firefox cannot stand in for Firefox 128');
    assert.equal(test.browser?.['moz:geckodriverVersion'], '0.35.0', 'use the tested compatible driver');
    assert.equal(test.browser?.['moz:headless'], false, 'native focus checks require a headed browser');
    assert.equal(test.target?.installation, 'persistent', 'restart must retain the installed add-on');
    assert.equal(test.target?.version, report.expectedVersion, 'every scenario must use the target release');
  }
  assert.equal(report.stats?.passed, compatibilityScenarioIds.length);
  assert.equal(report.stats?.bodiesStarted, compatibilityScenarioIds.length);
  for (const status of ['failed', 'blocked', 'not-run']) assert.equal(report.stats?.[status], 0);
  return { browser: 'Firefox 128.0 ESR', driver: '0.35.0', passed: report.tests.length,
    scope: 'Desktop compatibility only; minimum 113 and Android are not accepted' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(await readFile(process.env.BD_E2E_JSON || new URL('./results.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify(verifyCompatibilityResult(report), null, 2));
}
