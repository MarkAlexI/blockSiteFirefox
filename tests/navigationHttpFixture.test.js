import test from 'node:test';
import assert from 'node:assert/strict';
import { startNavigationHttpFixture } from '../e2e/navigation-http-fixture.mjs';

test('navigation fixture sends actual 301/302 Location responses and a safe real landing', async () => {
  const fixture = await startNavigationHttpFixture();
  try {
    for (const status of [301, 302]) {
      const response = await fetch(`${fixture.origin}/server/${status}`, { redirect: 'manual' });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('location'), `${fixture.origin}/blocked/${status}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.text();
    }
    const landing = await fetch(`${fixture.origin}/server/safe-301`);
    assert.equal(landing.status, 200); assert.equal(landing.url, `${fixture.origin}/landing`);
    assert.match(await landing.text(), /BD navigation fixture/);
    assert.equal(fixture.owns(new URL(fixture.origin + '/route')), true);
    assert.equal(fixture.owns(new URL('http://external.example/route')), false);
  } finally { await fixture.close(); }
});
