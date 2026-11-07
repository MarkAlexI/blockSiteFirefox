import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityScenarioIds } from './scenario-groups.mjs';
import { expectedVersion } from './target-version.mjs';

export function verifyCompatibilityResult(report, group = 'compatibility') {
  const browserVersion = { compatibility: '128.0', esr115: '115.31.0' }[group];
  assert.ok(browserVersion, 'known compatibility target required');
  assert.equal(report.platform?.platform, 'linux', 'compatibility evidence must come from Linux');
  assert.equal(report.group, group);
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
    assert.equal(test.browser?.browserVersion, browserVersion, 'the actual pinned browser must execute');
    assert.equal(test.browser?.['moz:geckodriverVersion'], '0.35.0', 'use the tested compatible driver');
    assert.equal(test.browser?.['moz:headless'], false, 'native focus checks require a headed browser');
    assert.equal(test.target?.installation, 'persistent', 'restart must retain the installed add-on');
    assert.equal(test.target?.version, report.expectedVersion, 'every scenario must use the target release');
    if (group === 'esr115') {
      assert.deepEqual(test.observedEvents, ['log.entryAdded'], 'ESR 115 has no BiDi user-prompt event');
      const [first, ...restarts] = test.hostAccess || [];
      assert.ok(first, 'every fresh ESR profile must exercise host permission onboarding');
      assert.equal(first.restarted, false);
      assert.equal(first.before, false, 'host access cannot be pre-granted');
      assert.equal(first.granted, true);
      assert.ok(['click', 'command'].includes(first.activation?.type), 'native HTML or XUL event required');
      assert.equal(first.activation.trusted, true, 'synthetic permission activation is not accepted');
      assert.equal(first.activation.detail, 0, 'host access uses trusted keyboard input');
      for (const entry of restarts) {
        assert.equal(entry.restarted, true);
        assert.equal(entry.before, true, 'host access must persist without another prompt');
        assert.equal(entry.granted, true);
        assert.equal(entry.activation, undefined, 'restart must not repeat the grant');
      }
    }
  }
  assert.equal(report.stats?.passed, compatibilityScenarioIds.length);
  assert.equal(report.stats?.bodiesStarted, compatibilityScenarioIds.length);
  for (const status of ['failed', 'blocked', 'not-run']) assert.equal(report.stats?.[status], 0);
  return { browser: `Firefox ${browserVersion} ESR`, driver: '0.35.0', passed: report.tests.length,
    scope: 'Desktop compatibility only; minimum 113 and Android are not accepted' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(await readFile(process.env.BD_E2E_JSON || new URL('./results.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify(verifyCompatibilityResult(report, process.env.BD_E2E_GROUP || 'compatibility'), null, 2));
}
