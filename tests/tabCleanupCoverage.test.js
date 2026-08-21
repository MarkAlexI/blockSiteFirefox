import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
import { IS_FIREFOX } from '../utils/constants.js';

async function withTabCleanup(tabs, callback) {
  const api = createExtensionApi({ tabs });
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

test('disabled whitelist assignments do not protect tabs from whitelist-focus cleanup', async () => {
  await withTabCleanup([{ id: 7, url: 'https://allowed.example/' }], async ({
    api, closeNonWhitelistedTabs
  }) => {
    await closeNonWhitelistedTabs([allowedRule('allowed.example', true)]);
    assert.deepEqual(api.createdTabs, [{}]);
    assert.deepEqual(api.removedTabs, [7]);
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

test('tab-query failures do not escape either cleanup path', async () => {
  await withTabCleanup([], async ({ api, closeTabsMatchingRules, closeNonWhitelistedTabs }) => {
    api.tabs.query = async () => { throw new Error('tabs permission unavailable'); };
    await assert.doesNotReject(closeTabsMatchingRules(['example.com']));
    await assert.doesNotReject(closeNonWhitelistedTabs([allowedRule('example.com')]));
  });
});
