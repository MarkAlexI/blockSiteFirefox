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
  for (const group of ['compatibility', 'esr115']) {
    assert.deepEqual(selectScenarioGroup([...scenarios, { id: '65' }], group), scenarios);
    assert.throws(() => selectScenarioGroup(scenarios.slice(1), group), /Incomplete/);
    assert.throws(() => selectScenarioGroup([...scenarios, scenarios[0]], group), /duplicate/);
  }
});

const esrEvidence = () => {
  const report = evidence(); report.group = 'esr115';
  for (const item of report.tests) {
    item.browser.browserVersion = '115.31.0'; item.observedEvents = ['log.entryAdded'];
    item.hostAccess = [{ before: false, granted: true, restarted: false,
      activation: { type: 'command', trusted: true, detail: 0 } },
      { before: true, granted: true, restarted: true }];
  }
  return report;
};

test('ESR 115 gate accepts trusted native onboarding and persisted permission after restart', () => {
  assert.equal(verifyCompatibilityResult(esrEvidence(), 'esr115').passed, 7);
  assert.throws(() => verifyCompatibilityResult(evidence(), 'esr115'));
  assert.throws(() => verifyCompatibilityResult(esrEvidence(), 'compatibility'));
});

test('ESR 115 gate rejects absent or synthetic grants and permission loss hidden by re-grant', () => {
  const changes = [r => delete r.tests[0].hostAccess,
    r => r.tests[0].hostAccess[0].before = true,
    r => r.tests[0].hostAccess[0].granted = false,
    r => r.tests[0].hostAccess[0].activation.trusted = false,
    r => r.tests[0].hostAccess[0].activation.type = 'custom',
    r => r.tests[0].hostAccess[1].before = false,
    r => r.tests[0].hostAccess[1].activation = { type: 'command', trusted: true, detail: 0 },
    r => r.tests[0].observedEvents.push('browsingContext.userPromptOpened')];
  for (const change of changes) {
    const report = esrEvidence(); change(report);
    assert.throws(() => verifyCompatibilityResult(report, 'esr115'));
  }
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
