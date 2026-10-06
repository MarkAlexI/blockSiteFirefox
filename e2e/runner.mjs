import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scenarios } from './firefox.spec.mjs';
import { ExtensionHarness, EnvironmentError } from './fixtures.mjs';
import { expectedVersion } from './target-version.mjs';

const args = process.argv.slice(2);
const known = args.every(arg => ['--list', '--headed'].includes(arg) || /^(--filter=|--max-failures=)/.test(arg));
if (!known) throw new Error('Usage: node runner.mjs [--list] [--headed] [--filter=ID-or-title] [--max-failures=N]');
const filter = args.find(arg => arg.startsWith('--filter='))?.slice(9);
const selected = scenarios.filter(test => !filter || test.id === filter || test.title.includes(filter));
assert.ok(selected.length, 'No scenarios selected');
if (args.includes('--list')) {
  for (const test of selected) console.log(`${test.id} ${test.title}${test.persistent ? ' [persistent installation]' : ''}`);
  console.log(`Total: ${selected.length} Firefox Desktop scenarios`);
} else {
  const installation = process.env.BD_INSTALLATION || 'persistent';
  assert.ok(['persistent', 'temporary'].includes(installation), 'BD_INSTALLATION must be persistent or temporary');
  const maximum = Number(args.find(arg => arg.startsWith('--max-failures='))?.slice(15) || Infinity);
  assert.ok(maximum > 0 && (maximum === Infinity || Number.isInteger(maximum)), 'invalid --max-failures');
  const output = path.resolve(process.env.BD_E2E_RESULTS || 'test-results');
  const reportFile = path.resolve(process.env.BD_E2E_JSON || 'results.json');
  const report = { schemaVersion: 1, runner: 'Selenium WebDriver + native Firefox BiDi + loopback HTTP/TLS fixture',
    startedAt: new Date().toISOString(), expectedVersion,
    platform: { platform: process.platform, architecture: process.arch, node: process.version },
    selected: selected.length, completeSuite: selected.length === scenarios.length, tests: [] };
  let failures = 0, setupBlocked = false;
  await mkdir(output, { recursive: true });
  await mkdir(path.dirname(reportFile), { recursive: true });
  for (const scenario of selected) {
    const result = { id: scenario.id, title: scenario.title, status: 'not-run', bodyStarted: false };
    report.tests.push(result);
    if (setupBlocked || failures >= maximum) { result.reason = 'Stopped after previous failure'; continue; }
    if (scenario.persistent && installation !== 'persistent') {
      result.status = 'blocked'; result.reason = 'Restart requires persistent installation'; failures++;
      console.log(`BLOCKED ${scenario.id}: ${result.reason}`); continue;
    }
    const started = Date.now();
    const harness = new ExtensionHarness({ headless: !args.includes('--headed'), installation,
      output: path.join(output, scenario.id) }, result);
    try {
      await harness.prepare(); await harness.launch(); await harness.seed();
      result.bodyStarted = true; harness.phase = 'scenario';
      await scenario.run(harness);
      assert.deepEqual(harness.pageErrors, [], 'Unexpected JavaScript errors');
      assert.deepEqual(harness.networkErrors, [], 'HTTP/TLS fixture errors');
      result.status = 'passed';
      console.log(`PASS ${scenario.id}: ${scenario.title}`);
    } catch (error) {
      result.phase = harness.phase;
      result.status = !result.bodyStarted || error instanceof EnvironmentError ? 'blocked' : 'failed';
      result.error = { name: error.name, message: error.message, stack: error.stack };
      if (!result.bodyStarted) setupBlocked = true;
      failures++;
      console.error(`${result.status.toUpperCase()} ${scenario.id} (${harness.phase}): ${error.message}`);
    } finally {
      try { await harness.close(); }
      catch (error) {
        result.cleanupError = error.stack;
        if (result.status === 'passed') { result.status = 'failed'; failures++; }
      }
      result.durationMs = Date.now() - started;
      // Persist results after every scenario so completed evidence survives an interruption.
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    }
  }
  report.finishedAt = new Date().toISOString();
  report.stats = Object.fromEntries(['passed', 'failed', 'blocked', 'not-run'].map(status =>
    [status, report.tests.filter(test => test.status === status).length]));
  report.stats.bodiesStarted = report.tests.filter(test => test.bodyStarted).length;
  report.status = report.stats.passed === selected.length ? 'passed' : report.stats.failed ? 'failed' : 'blocked';
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`Result: ${report.status}; ${JSON.stringify(report.stats)}; report=${reportFile}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
