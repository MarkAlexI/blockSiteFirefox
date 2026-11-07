import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityScenarioIds, selectScenarioGroup } from '../e2e/scenario-groups.mjs';
import { verifyCompatibilityResult } from '../e2e/verify-compatibility-result.mjs';
import { expectedVersion } from '../e2e/target-version.mjs';

const evidence = () => ({ platform: { platform: 'linux' }, group: 'compatibility', status: 'passed',
  finishedAt: '2026-11-07T00:00:00Z', expectedVersion, selected: 7,
  tests: compatibilityScenarioIds.map(id => ({ id, status: 'passed', bodyStarted: true,
    browser: { browserName: 'firefox', browserVersion: '128.0', 'moz:geckodriverVersion': '0.35.0', 'moz:headless': false },
    target: { installation: 'persistent', version: expectedVersion } })),
  stats: { passed: 7, failed: 0, blocked: 0, 'not-run': 0, bodiesStarted: 7 } });

test('compatibility selection retains native bodies and rejects partial or duplicate inventory', () => {
  const scenarios = compatibilityScenarioIds.toReversed().map(id => ({ id }));
  assert.deepEqual(selectScenarioGroup([...scenarios, { id: '65' }], 'compatibility'), scenarios);
  assert.throws(() => selectScenarioGroup(scenarios.slice(1), 'compatibility'), /Incomplete/);
  assert.throws(() => selectScenarioGroup([...scenarios, scenarios[0]], 'compatibility'), /duplicate/);
});

test('compatibility gate accepts complete Firefox 128 native evidence', () => {
  assert.equal(verifyCompatibilityResult(evidence()).passed, 7);
});

test('compatibility gate rejects another browser, driver or release and temporary installation', () => {
  const changes = [r => r.tests[0].browser.browserVersion = '158.0',
    r => r.tests[0].browser.browserName = 'chrome',
    r => r.tests[0].browser['moz:geckodriverVersion'] = '0.37.1',
    r => r.tests[0].browser['moz:headless'] = true,
    r => r.tests[0].target.installation = 'temporary',
    r => r.tests[0].target.version = '0.0.0',
    r => { r.expectedVersion = '0.0.0'; for (const item of r.tests) item.target.version = '0.0.0'; }];
  for (const change of changes) { const report = evidence(); change(report); assert.throws(() => verifyCompatibilityResult(report)); }
});

test('compatibility gate rejects skipped bodies, duplicate results, failed cleanup and unfinished reports', () => {
  const changes = [r => r.tests[0].bodyStarted = false, r => r.tests[0].status = 'blocked',
    r => r.tests[0].cleanupError = 'cleanup failed', r => r.tests[0].id = r.tests[1].id,
    r => r.tests.pop(), r => delete r.finishedAt, r => r.stats.bodiesStarted = 6];
  for (const change of changes) { const report = evidence(); change(report); assert.throws(() => verifyCompatibilityResult(report)); }
});
