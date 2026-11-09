import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

test('tab cleanup uses the same partial domain-label matching contract as DNR', async () => {
  const previousBrowser = globalThis.browser;
  const removed = [];
  let created = 0;
  globalThis.browser = {
    storage: {
      sync: {
        get(_keys, callback) { callback({}); },
        set(_value, callback) { if (typeof callback === 'function') callback(); }
      },
      onChanged: {
        addListener() {}
      }
    },
    tabs: {
      async query() {
        return [
          { id: 1, url: 'https://m.youtube.com/watch?v=1' },
          { id: 2, url: 'https://notyoutube.com/' },
          { id: 3, url: 'https://example.com/' }
        ];
      },
      async create() { created++; },
      async remove(ids) { removed.push(...ids); }
    }
  };

  try {
    const { closeTabsMatchingRules } = await import('../scripts/closeTabs.js');
    await closeTabsMatchingRules(['yout']);
    assert.deepEqual(removed, [1]);
    assert.equal(created, 0);
  } finally {
    globalThis.browser = previousBrowser;
  }
});

test('URL ports: tab cleanup preserves matching paths on a different port', async () => {
  const api = createExtensionApi();
  api.tabs.values = [
    { id: 1, windowId: 1, url: 'https://example.test:8080/path/one' },
    { id: 2, windowId: 1, url: 'https://example.test:8081/path/one' },
    { id: 3, windowId: 1, url: 'https://example.test/path/one' },
    { id: 4, windowId: 1, url: 'about:blank' }
  ];
  await withExtensionEnvironment(api, async () => {
    const { closeTabsMatchingRules } = await import('../scripts/closeTabs.js');
    await closeTabsMatchingRules(['example.test:8080/path']);
    assert.deepEqual(api.removedTabs, [1]);
  });
});


test('URL wildcards: cleanup closes matching web tabs and preserves browser pages', async () => {
  const api = createExtensionApi();
  api.tabs.values = [
    { id: 1, windowId: 1, url: 'https://example.test/feeds/one/watch' },
    { id: 2, windowId: 1, url: 'https://example.test/feeds/one/read' },
    { id: 3, windowId: 1, url: 'chrome://components/' },
    { id: 4, windowId: 1, url: 'about:blank' }
  ];
  await withExtensionEnvironment(api, async () => {
    const { closeTabsMatchingRules } = await import('../scripts/closeTabs.js');
    await closeTabsMatchingRules(['example.test/feed*/watch', 'com']);
    assert.deepEqual(api.removedTabs, [1]);
  });
});
