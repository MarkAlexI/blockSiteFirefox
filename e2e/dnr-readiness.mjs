import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { arch, availableParallelism, cpus, release, totalmem } from 'node:os';

export const measurementEnvironment = () => ({ platform: process.platform, node: process.version,
  architecture: arch(), osRelease: release(), cpuModel: cpus()[0]?.model ?? 'unknown',
  logicalCpus: cpus().length, availableParallelism: availableParallelism(), memoryBytes: totalmem() });

// Runs in an ordinary HTTP main frame, including during native session restore.
// Fetch only records a positive control; the ruled request is a real navigation.
export async function runDnrNavigationProbe({ attemptUrl }) {
  try {
    const url = new URL(attemptUrl);
    url.searchParams.set('origin', performance.timeOrigin);
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('DNR observation owner unavailable');
    const next = await response.json();
    if (next.enabled) location.replace(next.url);
  } catch (error) {
    document.body.textContent = String(error);
    document.documentElement.dataset.dnrProbeError = 'true';
  }
}

export function createDnrStartupProbe({ port = '' } = {}) {
  const token = randomUUID().replaceAll('-', '');
  const host = `dnr-blocked-${token}.bd-e2e.test`;
  const prefix = `/dnr-${token}`;
  const controlOrigin = `http://dnr-control-${token}.bd-e2e.test${port ? ':' + port : ''}`;
  const targetOrigin = `http://${host}${port ? ':' + port : ''}`;
  const urls = { control: controlOrigin + prefix + '/control',
    attempt: controlOrigin + prefix + '/attempt',
    reachable: targetOrigin + prefix + '/reachable', target: targetOrigin + prefix + '/target' };
  const reachable = [], attempts = [], allowedRequests = [];
  let launchedAt = null;
  const owns = url => [controlOrigin, targetOrigin].includes(url.origin) && url.pathname.startsWith(prefix + '/');
  const html = script => `<!doctype html><html data-dnr-fixture="${token}"><head><title>DNR startup probe</title></head><body>
    <p>Owned main-frame DNR probe</p>${script ? `<script>${script}</script>` : ''}</body></html>`;
  return {
    token, host, urls, owns,
    startColdLaunch(at) {
      assert.equal(launchedAt, null, 'one cold observation per probe');
      assert.ok(Number.isFinite(at) && at > 0);
      launchedAt = at;
    },
    htmlFor(url) {
      if (!owns(url)) return null;
      if (url.href === urls.reachable) {
        reachable.push({ at: Date.now(), url: url.href });
        return html('');
      }
      if (url.href === urls.control) {
        return html(`(${runDnrNavigationProbe.toString()})(${JSON.stringify({ attemptUrl: urls.attempt })});`);
      }
      if (url.origin === controlOrigin && url.pathname === prefix + '/attempt') {
        const origin = Number(url.searchParams.get('origin'));
        if (launchedAt === null || !Number.isFinite(origin) || origin < launchedAt || attempts.length >= 1000) {
          return JSON.stringify({ enabled: false });
        }
        const attempt = { id: attempts.length + 1, documentOrigin: origin, at: Date.now() };
        attempts.push(attempt);
        return JSON.stringify({ enabled: true, url: urls.target + '?attempt=' + attempt.id });
      }
      if (url.origin === targetOrigin && url.pathname === prefix + '/target') {
        allowedRequests.push({ attemptId: Number(url.searchParams.get('attempt')), at: Date.now(), url: url.href });
        return html(`setTimeout(() => location.replace(${JSON.stringify(urls.control)}), 50);`);
      }
      return html('');
    },
    snapshot() {
      return structuredClone({ token, host, urls, launchedAt, reachable, attempts, allowedRequests });
    }
  };
}

export async function createDnrStartupFixture() {
  let probe;
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const body = request.method === 'GET' ? probe?.htmlFor(url) : null;
    response.writeHead(body === null || body === undefined ? 404 : 200,
      { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body ?? 'Unowned DNR fixture request');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  probe = createDnrStartupProbe({ port: server.address().port });
  let closing;
  return { ...probe, endpoint: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (!closing) { closing = once(server, 'close'); server.close(); server.closeAllConnections(); }
      return closing;
    } };
}

// These observations bound test-visible enforcement, not the engine's exact
// initialization instant. DNR may already work before the first sampled request.
export function dnrReadinessReport(probe, observation, { extensionOrigin, observationFloorAt }) {
  const data = probe.snapshot();
  return { ...data, extensionOrigin, observationFloorAt, observation,
    firstBlockedObservedMs: observation.at - data.launchedAt,
    firstProbeStartedMs: data.attempts[0]?.at - data.launchedAt,
    firstBlockedAttemptStartedMs: data.attempts.at(-1)?.at - data.launchedAt,
    earlyAllowedRequests: data.allowedRequests.length,
    firstAttemptBlocked: data.attempts.length === 1 && data.allowedRequests.length === 0,
    interpretation: 'upper bound from independent native observation; not exact DNR initialization; early requests are reported without a performance budget' };
}

export function assertDnrReadiness(report) {
  assert.ok(report.reachable.some(event => event.at < report.launchedAt), 'same target reached HTTP before rule setup');
  assert.ok(report.attempts.length > 0, 'new process issued a real main-frame probe before UI');
  assert.ok(Number.isFinite(report.observationFloorAt) && report.observationFloorAt >= report.launchedAt);
  const last = report.attempts.at(-1);
  assert.ok(report.attempts.every((attempt, i) => attempt.id === i + 1 &&
    attempt.documentOrigin >= report.launchedAt && attempt.at >= report.launchedAt), 'only fresh process documents');
  const ids = report.allowedRequests.map(request => request.attemptId);
  assert.deepEqual(ids, report.attempts.slice(0, -1).map(attempt => attempt.id), 'every earlier attempt reached HTTP, final attempt did not');
  const redirected = new URL(report.observation.url);
  assert.equal(redirected.origin === 'null' ? `${redirected.protocol}//${redirected.host}` : redirected.origin,
    report.extensionOrigin, 'native extension redirect, not an HTTP error or DNS failure');
  assert.equal(redirected.pathname, '/blocked.html');
  assert.equal(redirected.searchParams.get('url'), report.host);
  assert.equal(redirected.searchParams.get('reason'), 'always');
  assert.ok(Number.isFinite(report.observation.documentOrigin) && report.observation.documentOrigin >= last.documentOrigin);
  assert.ok(report.observation.at >= Math.max(last.at, report.observationFloorAt));
  assert.equal(report.earlyAllowedRequests, ids.length);
  assert.equal(report.firstAttemptBlocked, ids.length === 0);
  assert.equal(report.firstBlockedObservedMs, report.observation.at - report.launchedAt);
  assert.equal(report.firstProbeStartedMs, report.attempts[0].at - report.launchedAt);
  assert.equal(report.firstBlockedAttemptStartedMs, last.at - report.launchedAt);
  for (const key of ['firstBlockedObservedMs', 'firstProbeStartedMs', 'firstBlockedAttemptStartedMs']) {
    assert.ok(Number.isFinite(report[key]) && report[key] >= 0, key);
  }
}
