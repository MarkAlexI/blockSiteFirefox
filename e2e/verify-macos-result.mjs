import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { macosSmokeScenarioIds } from './scenario-groups.mjs';

export function verifyMacosResult(report, architecture) {
  assert.ok(['arm64', 'x64'].includes(architecture), 'expected native architecture is required');
  assert.equal(report.platform?.platform, 'darwin', 'results must come from macOS');
  assert.equal(report.platform?.architecture, architecture, 'native architecture must match the job');
  assert.equal(report.group, 'macos-smoke');
  assert.equal(report.status, 'passed');
  assert.ok(report.finishedAt, 'the runner must have finished');
  assert.equal(report.selected, macosSmokeScenarioIds.length);
  assert.deepEqual(report.tests.map(test => test.id).sort(), [...macosSmokeScenarioIds].sort(),
    'every acceptance scenario must execute exactly once');
  for (const test of report.tests) {
    assert.equal(test.status, 'passed', `scenario ${test.id} must pass`);
    assert.equal(test.bodyStarted, true, `scenario ${test.id} body must execute`);
    assert.equal(test.cleanupError, undefined, `scenario ${test.id} cleanup must succeed`);
  }
  assert.equal(report.stats?.passed, macosSmokeScenarioIds.length);
  for (const status of ['failed', 'blocked', 'not-run']) assert.equal(report.stats?.[status], 0);
  return { platform: 'darwin', architecture, passed: report.tests.length, scope: 'macos-smoke' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify(verifyMacosResult(report, process.env.BD_EXPECTED_ARCH), null, 2));
}
