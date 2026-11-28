import test from 'node:test';
import assert from 'node:assert/strict';
import { startNavigationCacheFixture } from '../e2e/navigation-cache-fixture.mjs';

test('cache fixture serves cacheable native redirects and history documents separately from the service-worker script', async () => {
  const fixture = await startNavigationCacheFixture();
  try {
    for (const status of [301, 302]) {
      const reply = await fetch(`${fixture.origin}/cache/redirect/${status}`, { redirect: 'manual' });
      assert.equal(reply.status, status);
      assert.equal(reply.headers.get('location'), `${fixture.origin}/cache/landing/${status}`);
      assert.equal(reply.headers.get('cache-control'), 'public, max-age=3600');
      await reply.text();
    }
    const history = await fetch(`${fixture.origin}/cache/history/a`);
    assert.equal(history.status, 200);
    assert.equal(history.headers.get('cache-control'), 'public, max-age=600');
    await history.text();
    const worker = await fetch(`${fixture.origin}/cache/sw/worker.js`);
    assert.match(worker.headers.get('content-type'), /^text\/javascript/);
    assert.equal(worker.headers.get('cache-control'), 'no-store');
    await worker.text();
    assert.equal(fixture.owns(new URL(`${fixture.origin}/cache/history/a`)), true);
    assert.equal(fixture.owns(new URL('https://example.com/cache/history/a')), false);
    assert.equal(fixture.requests.length, 4);
  } finally { await fixture.close(); }
});
