import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
import { IS_FIREFOX } from '../utils/constants.js';

async function withTabCleanup(tabs, callback, { supportsWindows = true } = {}) {
  const api = createExtensionApi({ tabs });
  if (supportsWindows) api.windows = {};
  await withExtensionEnvironment(api, async () => {
    const cleanup = await import('../scripts/closeTabs.js');
    await callback({ api, ...cleanup });
  });
}

const allowedRule = (blockURL, disabledByUser = false) => ({
  blockURL,
  isWhitelist: true,
  assignments: [{
    listId: 'general',
    disabledByUser,
    blockingMode: 'always',
    schedule: null,
    dailyLimit: null
  }]
});

test('tab cleanup ignores blank patterns and tabs without URLs', async () => {
  await withTabCleanup([{ id: 1 }, { id: 2, url: 'https://example.com/' }], async ({
    api, closeTabsMatchingRules
  }) => {
    await closeTabsMatchingRules([' ', null, undefined]);
    assert.deepEqual(api.removedTabs, []);
    await closeTabsMatchingRules(['missing.example']);
    assert.deepEqual(api.removedTabs, []);
  });
});

test('tab cleanup normalizes pasted patterns and preserves unrelated tabs', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://www.Example.com/team' },
    { id: 2, url: 'https://safe.example.org/' }
  ], async ({ api, closeTabsMatchingRules }) => {
    await closeTabsMatchingRules(['  EXAMPLE.COM  ']);
    assert.deepEqual(api.removedTabs, [1]);
    assert.deepEqual(api.createdTabs, []);
  });
});

test('matching cleanup preserves OAuth and project tabs while closing real distracting hosts', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://accounts.youtube.com/accounts/SetSID' },
    { id: 2, url: 'https://m.youtube.com/watch?v=1' },
    { id: 3, url: 'https://accounts.google.com/o/oauth2/auth' },
    { id: 4, url: 'https://www.google.com/search?q=test' },
    { id: 5, url: 'https://blockdistraction.com/login.html' },
    { id: 6, url: 'https://blocking.example/' }
  ], async ({ api, closeTabsMatchingRules }) => {
    await closeTabsMatchingRules(['yout', 'goog', 'block']);

    assert.deepEqual(api.removedTabs, [2, 4, 6]);
    assert.deepEqual(api.createdTabs, []);
  }, { supportsWindows: false });
});

test('closing every matching tab creates a replacement tab before removing the final browser tab', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://example.com/' },
    { id: 2, url: 'https://m.example.com/' }
  ], async ({ api, closeTabsMatchingRules }) => {
    await closeTabsMatchingRules(['example.com']);
    assert.deepEqual(api.createdTabs, [{}]);
    assert.deepEqual(api.removedTabs, [1, 2]);
  });
});

test('matching cleanup preserves every affected browser window independently', async () => {
  await withTabCleanup([
    { id: 1, windowId: 10, url: 'https://example.com/' },
    { id: 2, windowId: 20, url: 'https://m.example.com/' },
    { id: 3, windowId: 30, url: 'https://safe.example.org/' }
  ], async ({ api, closeTabsMatchingRules }) => {
    await closeTabsMatchingRules(['example.com']);
    assert.deepEqual(api.createdTabs, [{ windowId: 10 }, { windowId: 20 }]);
    assert.deepEqual(api.removedTabs, [1, 2]);
  });
});

test('windowless platforms use the current tab container for their safety tab', async () => {
  await withTabCleanup([
    { id: 1, windowId: 10, url: 'https://example.com/' }
  ], async ({ api, closeTabsMatchingRules }) => {
    await closeTabsMatchingRules(['example.com']);
    assert.deepEqual(api.createdTabs, [{}]);
    assert.deepEqual(api.removedTabs, [1]);
  }, { supportsWindows: false });
});

test('a superseded cleanup does not close tabs after its asynchronous tab query', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://restored.example/' },
    { id: 2, url: 'https://safe.example/' }
  ], async ({ api, closeTabsMatchingRules }) => {
    let current = true;
    const originalQuery = api.tabs.query.bind(api.tabs);
    let queryStarted;
    let releaseQuery;
    const queryReady = new Promise(resolve => { queryStarted = resolve; });
    const queryGate = new Promise(resolve => { releaseQuery = resolve; });
    api.tabs.query = async (...args) => {
      queryStarted();
      await queryGate;
      return originalQuery(...args);
    };

    const cleanup = closeTabsMatchingRules(['restored.example'], () => current);
    await queryReady;
    current = false;
    releaseQuery();
    await cleanup;

    assert.deepEqual(api.removedTabs, []);
    assert.deepEqual(api.createdTabs, []);
  });
});

test('a cleanup superseded while opening a safety tab never removes the original tabs', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://restored.example/' }
  ], async ({ api, closeTabsMatchingRules }) => {
    let current = true;
    const originalCreate = api.tabs.create.bind(api.tabs);
    api.tabs.create = async details => {
      const result = await originalCreate(details);
      current = false;
      return result;
    };

    await closeTabsMatchingRules(['restored.example'], () => current);

    assert.deepEqual(api.createdTabs, [{}]);
    assert.deepEqual(api.removedTabs, []);
  });
});

test('a superseded whitelist cleanup does not close tabs after its asynchronous tab query', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://blocked.example/' }
  ], async ({ api, closeNonWhitelistedTabs }) => {
    let current = true;
    const originalQuery = api.tabs.query.bind(api.tabs);
    const queryStarted = new Promise(resolve => {
      api.tabs.query = async (...args) => {
        resolve();
        await new Promise(release => setImmediate(release));
        return originalQuery(...args);
      };
    });

    const cleanup = closeNonWhitelistedTabs(
      [allowedRule('allowed.example')],
      () => current
    );
    await queryStarted;
    current = false;
    await cleanup;

    assert.deepEqual(api.removedTabs, []);
    assert.deepEqual(api.createdTabs, []);
  });
});

test('whitelist focus preserves allowed domains and protected browser pages', async () => {
  const protectedUrl = IS_FIREFOX ? 'about:config' : 'chrome://settings/';
  await withTabCleanup([
    { id: 1, url: 'https://allowed.example/team' },
    { id: 2, url: 'https://blocked.example/' },
    { id: 3, url: protectedUrl },
    { id: 4, url: 'moz-extension://example/options/options.html' },
    { id: 0, url: 'https://ignored.example/' },
    { id: 5 }
  ], async ({ api, closeNonWhitelistedTabs }) => {
    await closeNonWhitelistedTabs([allowedRule('allowed.example')]);
    assert.deepEqual(api.removedTabs, [2]);
    assert.deepEqual(api.createdTabs, []);
  });
});

test('whitelist Focus preserves Google sign-in and YouTube account handoff popups', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://accounts.google.com/o/oauth2/auth' },
    { id: 2, url: 'https://accounts.youtube.com/accounts/SetSID' },
    { id: 3, url: 'https://youtube.com/watch?v=1' },
    { id: 4, url: 'https://allowed.example/' }
  ], async ({ api, closeNonWhitelistedTabs }) => {
    await closeNonWhitelistedTabs([allowedRule('allowed.example')]);

    assert.deepEqual(api.removedTabs, [3]);
    assert.deepEqual(api.createdTabs, []);
  }, { supportsWindows: false });
});

test('disabled whitelist assignments do not protect tabs from whitelist-focus cleanup', async () => {
  await withTabCleanup([{ id: 7, url: 'https://allowed.example/' }], async ({
    api, closeNonWhitelistedTabs
  }) => {
    await closeNonWhitelistedTabs([allowedRule('allowed.example', true)]);
    assert.deepEqual(api.createdTabs, [{}]);
    assert.deepEqual(api.removedTabs, [7]);
  });
});

test('whitelist cleanup closes lookalike domains and protected-name query bypasses', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://allowed.example/team' },
    { id: 2, url: 'https://notallowed.example/' },
    { id: 3, url: 'https://evil.example/?next=allowed.example' },
    { id: 4, url: 'https://evil.example/?next=blockdistraction.com' },
    { id: 5, url: 'https://evil.example/markdigital' },
    { id: 6, url: 'https://blockdistraction.com/account.html' }
  ], async ({ api, closeNonWhitelistedTabs }) => {
    await closeNonWhitelistedTabs([allowedRule('allowed.example')]);
    assert.deepEqual(api.removedTabs, [2, 3, 4, 5]);
    assert.deepEqual(api.createdTabs, []);
  });
});

test('whitelist cleanup does nothing when all open tabs remain allowed', async () => {
  await withTabCleanup([
    { id: 1, url: 'https://allowed.example/' },
    { id: 2, url: 'https://sub.allowed.example/path' }
  ], async ({ api, closeNonWhitelistedTabs }) => {
    await closeNonWhitelistedTabs([allowedRule('allowed.example')]);
    assert.deepEqual(api.removedTabs, []);
    assert.deepEqual(api.createdTabs, []);
  });
});

test('whitelist cleanup preserves an affected window even when another window stays open', async () => {
  await withTabCleanup([
    { id: 1, windowId: 10, url: 'https://blocked.example/' },
    { id: 2, windowId: 20, url: 'https://allowed.example/' }
  ], async ({ api, closeNonWhitelistedTabs }) => {
    await closeNonWhitelistedTabs([allowedRule('allowed.example')]);
    assert.deepEqual(api.createdTabs, [{ windowId: 10 }]);
    assert.deepEqual(api.removedTabs, [1]);
  });
});

test('tab-query failures do not escape either cleanup path', async () => {
  await withTabCleanup([], async ({ api, closeTabsMatchingRules, closeNonWhitelistedTabs }) => {
    api.tabs.query = async () => { throw new Error('tabs permission unavailable'); };
    await assert.doesNotReject(closeTabsMatchingRules(['example.com']));
    await assert.doesNotReject(closeNonWhitelistedTabs([allowedRule('example.com')]));
  });
});
