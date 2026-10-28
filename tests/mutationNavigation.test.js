import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createMutationNavigationFixture, createMutationNavigationProbe, assertMutationNavigation } from '../e2e/mutation-navigation.mjs';

test('native navigation fixture records actual HTTP receipts and never caches them', async () => {
  const fixture = await createMutationNavigationFixture();
  try {
    const host = fixture.hosts.sentinel;
    // Only the transport fixture is tested here; this is not a native DNR run.
    const port = fixture.port;
    const response = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: `/${fixture.token}/target?attempt=2`,
        headers: { host: `${host}:${port}` } }, reply => {
        let body = ''; reply.on('data', chunk => { body += chunk; });
        reply.on('end', () => resolve({ status: reply.statusCode, headers: reply.headers, body }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.body, new RegExp(fixture.token));
    assert.deepEqual(fixture.snapshot().receipts.map(({ host, kind, attempt }) => ({ host, kind, attempt })), [{ host, kind: 'target', attempt: 2 }]);
  } finally { await fixture.close(); }
});

function blockedEvidence() {
  const probe = createMutationNavigationProbe({ token: 'unit' });
  const { control, sentinel } = probe.hosts;
  probe.htmlFor(`http://${control}/unit/control?attempt=1`);
  const evidence = probe.snapshot();
  evidence.observations.push({ attempt: 1, phase: 'unit', host: sentinel, blocked: true,
    startedAt: 0, endedAt: Date.now(), extensionOrigin: 'chrome-extension://id',
    document: { url: `chrome-extension://id/blocked.html?url=${sentinel}&reason=always` } });
  return evidence;
}

test('native blocked-URL evidence also requires a positive HTTP control and no target receipt', () => {
  const evidence = blockedEvidence();
  assertMutationNavigation(evidence);
  for (const damage of [
    value => { value.receipts = []; },
    value => { value.receipts.push({ kind: 'target', attempt: 1, host: value.observations[0].host }); },
    value => { value.observations[0].document.url = 'chrome-extension://other/blocked.html?url=x&reason=always'; },
    value => { value.observations[0].document.url = 'http://' + value.observations[0].host; },
    value => { value.overflow = true; }
  ]) {
    const broken = structuredClone(evidence); damage(broken);
    assert.throws(() => assertMutationNavigation(broken));
  }
});

test('an allowed URL without its real HTTP document and receipt is rejected', () => {
  const evidence = blockedEvidence(), sample = evidence.observations[0];
  sample.blocked = false;
  sample.document = { url: `http://${sample.host}/unit/target?attempt=1`, token: 'unit', attempt: 1, kind: 'target' };
  assert.throws(() => assertMutationNavigation(evidence), /really reached/);
  evidence.receipts.push({ kind: 'target', attempt: 1, host: sample.host });
  assertMutationNavigation(evidence);
  sample.document.token = 'stale-document';
  assert.throws(() => assertMutationNavigation(evidence));
});
