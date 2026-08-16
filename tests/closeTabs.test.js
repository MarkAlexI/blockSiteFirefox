import test from 'node:test';
import assert from 'node:assert/strict';

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
    const { closeTabsMatchingRules } = await import(`../scripts/closeTabs.js?test=${Date.now()}`);
    await closeTabsMatchingRules(['yout']);
    assert.deepEqual(removed, [1]);
    assert.equal(created, 0);
  } finally {
    globalThis.browser = previousBrowser;
  }
});
