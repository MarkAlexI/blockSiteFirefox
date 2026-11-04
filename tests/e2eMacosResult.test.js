import test from 'node:test';
import assert from 'node:assert/strict';
import { macosSmokeScenarioIds } from '../e2e/scenario-groups.mjs';
import { verifyMacosResult } from '../e2e/verify-macos-result.mjs';

const passed = architecture => ({
  platform: { platform: 'darwin', architecture }, group: 'macos-smoke', status: 'passed',
  finishedAt: '2026-11-04T20:00:00.000Z', selected: 24,
  tests: macosSmokeScenarioIds.map(id => ({ id, status: 'passed', bodyStarted: true })),
  stats: { passed: 24, failed: 0, blocked: 0, 'not-run': 0 }
});

test('macOS acceptance requires native execution on the requested architecture', () => {
  for (const architecture of ['arm64', 'x64']) {
    assert.equal(verifyMacosResult(passed(architecture), architecture).passed, 24);
  }
  assert.throws(() => verifyMacosResult(passed('x64'), 'arm64'), /architecture/);
  assert.throws(() => verifyMacosResult(passed('x64'), undefined), /architecture/);
  const linux = passed('x64'); linux.platform.platform = 'linux';
  assert.throws(() => verifyMacosResult(linux, 'x64'), /macOS/);
});

test('a green summary cannot hide an unstarted, blocked, failed or duplicate scenario', () => {
  for (const status of ['blocked', 'failed', 'not-run']) {
    const report = passed('arm64'); report.tests[0].status = status;
    assert.throws(() => verifyMacosResult(report, 'arm64'), /must pass/);
  }
  const unstarted = passed('arm64'); unstarted.tests[0].bodyStarted = false;
  assert.throws(() => verifyMacosResult(unstarted, 'arm64'), /body must execute/);
  const duplicate = passed('arm64'); duplicate.tests[0].id = duplicate.tests[1].id;
  assert.throws(() => verifyMacosResult(duplicate, 'arm64'), /exactly once/);
  const interrupted = passed('arm64'); delete interrupted.finishedAt;
  assert.throws(() => verifyMacosResult(interrupted, 'arm64'), /finished/);
  const cleanup = passed('arm64'); cleanup.tests[0].cleanupError = 'owned browser did not close';
  assert.throws(() => verifyMacosResult(cleanup, 'arm64'), /cleanup/);
});
