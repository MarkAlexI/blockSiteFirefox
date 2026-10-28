import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createDnrStartupFixture, createDnrStartupProbe, runDnrNavigationProbe,
  dnrReadinessReport, assertDnrReadiness } from '../e2e/dnr-readiness.mjs';

// These are oracle/HTTP fixture controls, not measured native browser results.
function model({ allowed = 0, extensionOrigin = 'chrome-extension://owned' } = {}) {
  const probe = createDnrStartupProbe();
  probe.htmlFor(new URL(probe.urls.reachable));
  const launchedAt = Date.now() + 1;
  probe.startColdLaunch(launchedAt);
  for (let i = 0; i <= allowed; i++) {
    const next = JSON.parse(probe.htmlFor(new URL(probe.urls.attempt + '?origin=' + launchedAt)));
    if (i < allowed) probe.htmlFor(new URL(next.url));
  }
  const at = Math.max(Date.now(), launchedAt) + 1;
  const report = dnrReadinessReport(probe, { at, documentOrigin: at,
    url: extensionOrigin + '/blocked.html?url=' + probe.host + '&reason=always' },
  { extensionOrigin, observationFloorAt: launchedAt });
  // The controlled fixture calls above intentionally precede the synthetic launch.
  report.attempts.forEach(attempt => { attempt.at = launchedAt; });
  report.firstProbeStartedMs = report.firstBlockedAttemptStartedMs = 0;
  return report;
}

test('DNR oracle accepts native redirect evidence and reports early allowed attempts without hiding them', () => {
  for (const extensionOrigin of ['chrome-extension://owned', 'moz-extension://owned']) {
    for (const allowed of [0, 2]) {
      const report = model({ allowed, extensionOrigin });
      assertDnrReadiness(report);
      assert.equal(report.earlyAllowedRequests, allowed);
      assert.equal(report.firstAttemptBlocked, allowed === 0);
    }
  }
});

for (const [name, change] of [
  ['no reachable HTTP control', r => { r.reachable = []; }],
  ['API rules without native navigation', r => { r.attempts = []; }],
  ['old process document', r => { r.attempts[0].documentOrigin = r.launchedAt - 1; }],
  ['wrong extension', r => { r.observation.url = r.observation.url.replace('owned', 'other'); }],
  ['DNS or HTTP failure', r => { r.observation.url = r.urls.target; }],
  ['wrong ruled host', r => { r.observation.url = r.observation.url.replace(r.host, 'other.bd-e2e.test'); }],
  ['post-Focus tab closure', r => { r.observation.url = r.observation.url.replace('reason=always', 'reason=focus'); }],
  ['final request also reached HTTP', r => { r.allowedRequests.push({ attemptId: 1 }); }],
  ['missing earlier network receipt', r => { r.attempts.unshift({ ...r.attempts[0], id: 0 }); }],
  ['missing native timestamp', r => { delete r.observation.documentOrigin; }],
  ['fabricated zero early requests', r => { r.earlyAllowedRequests = 1; }],
  ['negative measured duration', r => { r.firstBlockedObservedMs = -1; }]
]) test(`DNR oracle rejects ${name}`, () => {
  const report = model(); change(report); assert.throws(() => assertDnrReadiness(report));
});

test('unarmed and old restored documents cannot start a cold DNR probe', () => {
  const probe = createDnrStartupProbe();
  const next = origin => JSON.parse(probe.htmlFor(new URL(probe.urls.attempt + '?origin=' + origin)));
  assert.equal(next(2000).enabled, false);
  probe.startColdLaunch(2000);
  for (const origin of ['bad', 1999]) assert.equal(next(origin).enabled, false);
  assert.equal(probe.snapshot().attempts.length, 0);
  assert.equal(next(2000).enabled, true);
  assert.equal(probe.snapshot().attempts.length, 1);
  assert.throws(() => probe.startColdLaunch(3000), /one cold observation/);
});

test('the actual serialized page records control via fetch then navigates its main frame to the ruled URL', async () => {
  const calls = [];
  await runInNewContext(`(${runDnrNavigationProbe.toString()})({attemptUrl:'http://control.bd-e2e.test/attempt'})`, {
    URL, performance: { timeOrigin: 2000 },
    fetch: async (url, options) => {
      calls.push({ kind: 'control', url: url.href, options });
      return { ok: true, json: async () => ({ enabled: true, url: 'http://blocked.bd-e2e.test/target?attempt=1' }) };
    },
    location: { replace: url => calls.push({ kind: 'main-frame-navigation', url }) }
  });
  assert.deepEqual(calls.map(call => call.kind), ['control', 'main-frame-navigation']);
  assert.equal(calls[0].url, 'http://control.bd-e2e.test/attempt?origin=2000');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[1].url, 'http://blocked.bd-e2e.test/target?attempt=1');
});

test('native HTTP fixture is uncached, token-scoped and records allowed main-frame requests', async t => {
  const fixture = await createDnrStartupFixture(); t.after(() => fixture.close());
  const request = address => new Promise((resolve, reject) => {
    const url = new URL(address), endpoint = new URL(fixture.endpoint);
    const req = get({ hostname: endpoint.hostname, port: endpoint.port, path: url.pathname + url.search,
      headers: { Host: url.host } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    });
    req.on('error', reject);
  });
  const reachable = await request(fixture.urls.reachable);
  assert.equal(reachable.status, 200); assert.equal(reachable.headers['cache-control'], 'no-store');
  assert.ok(reachable.body.includes(fixture.token));
  const control = await request(fixture.urls.control);
  assert.ok(control.body.includes('location.replace'));
  assert.equal(JSON.parse((await request(fixture.urls.attempt + '?origin=2000')).body).enabled, false);
  fixture.startColdLaunch(2000);
  const next = JSON.parse((await request(fixture.urls.attempt + '?origin=2000')).body);
  assert.equal(next.enabled, true);
  assert.equal((await request(next.url)).status, 200);
  assert.equal(fixture.snapshot().allowedRequests[0].attemptId, 1);
  assert.equal((await request(new URL('/unowned', fixture.endpoint).href)).status, 404);
  assert.equal(fixture.owns(new URL(fixture.urls.target.replace('http:', 'https:'))), false);
  assert.equal(fixture.owns(new URL(fixture.urls.target.replace(new URL(fixture.urls.target).hostname, 'other.bd-e2e.test'))), false);
  await fixture.close(); await fixture.close();
});
