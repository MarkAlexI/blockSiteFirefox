import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpaNavigationEnforcer } from '../scripts/spaNavigationEnforcer.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createHarness({
  currentUrl = 'https://www.youtube.com/shorts/one',
  resolveNavigation = async () => ({
    redirectUrl: 'extension://test/blocked.html?reason=always'
  }),
  shouldSkipUrl = url => url.startsWith('extension://')
} = {}) {
  const updates = [];
  const logs = [];
  const tab = { id: 7, url: currentUrl };
  const tabsApi = {
    async get(tabId) {
      assert.equal(tabId, tab.id);
      return { ...tab };
    },
    async update(tabId, details) {
      updates.push({ tabId, details: { ...details } });
      tab.url = details.url;
      return { ...tab };
    }
  };
  const logger = {
    log: (...args) => logs.push(args.join(' ')),
    info: (...args) => logs.push(args.join(' '))
  };

  return {
    enforcer: createSpaNavigationEnforcer({
      tabsApi,
      resolveNavigation,
      shouldSkipUrl,
      logger
    }),
    tab,
    updates,
    logs
  };
}

test('same-document navigation applies the resolved browser-rule redirect', async () => {
  const harness = createHarness();

  const result = await harness.enforcer.enforce(7, harness.tab.url);

  assert.deepEqual(result, { status: 'redirected' });
  assert.deepEqual(harness.updates, [{
    tabId: 7,
    details: { url: 'extension://test/blocked.html?reason=always' }
  }]);
});

test('protected destinations and unmatched URLs never update the tab', async () => {
  const protectedHarness = createHarness({
    currentUrl: 'extension://test/blocked.html',
    resolveNavigation: async () => {
      throw new Error('protected URLs must not resolve rules');
    }
  });
  const unmatchedHarness = createHarness({
    resolveNavigation: async () => null
  });

  assert.deepEqual(
    await protectedHarness.enforcer.enforce(7, protectedHarness.tab.url),
    { status: 'skipped_url' }
  );
  assert.deepEqual(
    await unmatchedHarness.enforcer.enforce(7, unmatchedHarness.tab.url),
    { status: 'no_match' }
  );
  assert.deepEqual(protectedHarness.updates, []);
  assert.deepEqual(unmatchedHarness.updates, []);
});

test('a newer URL change supersedes an older unresolved check', async () => {
  const first = createDeferred();
  const second = createDeferred();
  const firstUrl = 'https://www.youtube.com/shorts/one';
  const secondUrl = 'https://www.youtube.com/shorts/two';
  const harness = createHarness({
    currentUrl: firstUrl,
    resolveNavigation: url => url === firstUrl ? first.promise : second.promise
  });

  const firstCheck = harness.enforcer.enforce(7, firstUrl);
  harness.tab.url = secondUrl;
  const secondCheck = harness.enforcer.enforce(7, secondUrl);

  first.resolve({ redirectUrl: 'extension://test/blocked.html?first' });
  assert.deepEqual(await firstCheck, { status: 'superseded' });

  second.resolve({ redirectUrl: 'extension://test/blocked.html?second' });
  assert.deepEqual(await secondCheck, { status: 'redirected' });
  assert.deepEqual(harness.updates, [{
    tabId: 7,
    details: { url: 'extension://test/blocked.html?second' }
  }]);
});

test('a tab that moved without another listener event is protected by the fresh URL read', async () => {
  const resolution = createDeferred();
  const observedUrl = 'https://www.youtube.com/shorts/one';
  const harness = createHarness({
    currentUrl: observedUrl,
    resolveNavigation: () => resolution.promise
  });

  const check = harness.enforcer.enforce(7, observedUrl);
  harness.tab.url = 'https://www.youtube.com/watch?v=safe';
  resolution.resolve({ redirectUrl: 'extension://test/blocked.html' });

  assert.deepEqual(await check, { status: 'stale_url' });
  assert.deepEqual(harness.updates, []);
});

test('debug messages describe fixed outcomes without including visited URLs', async () => {
  const harness = createHarness();

  await harness.enforcer.enforce(7, harness.tab.url);

  const output = harness.logs.join('\n');
  assert.match(output, /URL change observed/);
  assert.match(output, /Active rule applied/);
  assert.doesNotMatch(output, /youtube|shorts|https?:\/\//i);
});
