import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
import { createSpaNavigationEnforcer } from '../scripts/spaNavigationEnforcer.js';

function deferred() {
  let resolve;
  const promise = new Promise(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

const allowed = [{ blockURL: 'allowed.example', isWhitelist: true,
  assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always' }] }];

// Keep browser side effects in the API model, so assertions cover surviving
// tabs/windows as well as the requested remove/create calls.
async function withCleanup(tabs, callback, supportsWindows = true) {
  const api = createExtensionApi({ tabs: structuredClone(tabs) });
  if (supportsWindows) api.windows = {};
  api.closedWindows = [];
  let nextId = 100;
  api.tabs.create = async details => {
    api.createdTabs.push(structuredClone(details));
    const tab = { id: nextId++, windowId: details.windowId ?? api.tabs.values[0]?.windowId,
      url: 'about:blank' };
    api.tabs.values.push(tab);
    return structuredClone(tab);
  };
  api.tabs.remove = async ids => {
    const removed = new Set(Array.isArray(ids) ? ids : [ids]);
    const oldWindows = new Set(api.tabs.values.map(tab => tab.windowId));
    api.removedTabs.push(...removed);
    api.tabs.values = api.tabs.values.filter(tab => !removed.has(tab.id));
    for (const id of oldWindows) {
      if (!api.tabs.values.some(tab => tab.windowId === id)) api.closedWindows.push(id);
    }
  };
  await withExtensionEnvironment(api, async () => {
    const cleanup = await import('../scripts/closeTabs.js');
    await callback({ api, ...cleanup });
  });
}

for (const mode of ['blacklist', 'whitelist']) {
  test(`${mode} cleanup protects a window when its safe survivor disappears during the first query`, async () => {
    await withCleanup([
      { id: 1, windowId: 10, url: 'https://blocked.example/' },
      { id: 2, windowId: 10, url: 'https://allowed.example/' }
    ], async ({ api, closeTabsMatchingRules, closeNonWhitelistedTabs }) => {
      const query = api.tabs.query.bind(api.tabs);
      let first = true;
      api.tabs.query = async (...args) => {
        const snapshot = await query(...args);
        if (first) {
          first = false;
          api.tabs.values = api.tabs.values.filter(tab => tab.id !== 2);
        }
        return snapshot;
      };
      if (mode === 'blacklist') await closeTabsMatchingRules(['blocked.example']);
      else await closeNonWhitelistedTabs(allowed);
      assert.deepEqual(api.removedTabs, [1]);
      assert.deepEqual(api.closedWindows, []);
      assert.deepEqual(api.createdTabs, [{ windowId: 10 }]);
    });
  });

  test(`${mode} cleanup recalculates window safety after another safety tab is created`, async () => {
    await withCleanup([
      { id: 1, windowId: 10, url: 'https://blocked.example/' },
      { id: 2, windowId: 10, url: 'https://allowed.example/' },
      { id: 3, windowId: 20, url: 'https://blocked.example/' }
    ], async ({ api, closeTabsMatchingRules, closeNonWhitelistedTabs }) => {
      const create = api.tabs.create;
      api.tabs.create = async details => {
        const tab = await create(details);
        if (details.windowId === 20) api.tabs.values = api.tabs.values.filter(tab => tab.id !== 2);
        return tab;
      };
      if (mode === 'blacklist') await closeTabsMatchingRules(['blocked.example']);
      else await closeNonWhitelistedTabs(allowed);
      assert.deepEqual(api.removedTabs, [1, 3]);
      assert.deepEqual(api.closedWindows, []);
      assert.deepEqual(api.createdTabs.map(details => details.windowId).sort(), [10, 20]);
    });
  });

  for (const pendingUrl of ['https://allowed.example/document', 'https://accounts.google.com/o/oauth2/auth', 'about:blank']) {
    test(`${mode} cleanup preserves a pending safe navigation to ${pendingUrl}`, async () => {
      await withCleanup([{ id: 1, windowId: 10, url: 'https://blocked.example/' }], async ({
        api, closeTabsMatchingRules, closeNonWhitelistedTabs
      }) => {
        const create = api.tabs.create;
        api.tabs.create = async details => {
          const tab = await create(details);
          api.tabs.values.find(candidate => candidate.id === 1).pendingUrl = pendingUrl;
          return tab;
        };
        if (mode === 'blacklist') await closeTabsMatchingRules(['blocked.example']);
        else await closeNonWhitelistedTabs(allowed);
        assert.deepEqual(api.removedTabs, []);
        assert.equal(api.tabs.values.find(tab => tab.id === 1)?.pendingUrl, pendingUrl);
        assert.deepEqual(api.closedWindows, []);
      });
    });
  }

  test(`${mode} cleanup still removes a tab navigating between two blocked pages`, async () => {
    await withCleanup([{ id: 1, windowId: 10, url: 'https://blocked.example/one',
      pendingUrl: 'https://blocked.example/two' }], async ({ api, closeTabsMatchingRules, closeNonWhitelistedTabs }) => {
      if (mode === 'blacklist') await closeTabsMatchingRules(['blocked.example']);
      else await closeNonWhitelistedTabs(allowed);
      assert.deepEqual(api.removedTabs, [1]);
      assert.deepEqual(api.closedWindows, []);
    }, false);
  });
}

test('SPA redirect preserves a pending safe navigation after resolveNavigation completes', async () => {
  const ready = deferred();
  const release = deferred();
  const tab = { id: 7, url: 'https://blocked.example/' };
  const updates = [];
  const enforcer = createSpaNavigationEnforcer({
    tabsApi: { get: async () => structuredClone(tab), update: async (_id, details) => updates.push(details) },
    resolveNavigation: async () => { ready.resolve(); await release.promise; return { redirectUrl: 'extension://test/blocked.html' }; }
  });
  const navigation = enforcer.enforce(7, tab.url);
  await ready.promise;
  tab.pendingUrl = 'https://allowed.example/document';
  release.resolve();
  await navigation;
  assert.deepEqual(updates, []);
});

test('completed newer SPA check cannot restore an old A-B-A token delayed in tabs.get', async () => {
  const ready = deferred();
  const release = deferred();
  const updates = [];
  let first = true;
  let resolveCount = 0;
  const enforcer = createSpaNavigationEnforcer({
    tabsApi: {
      get: async () => { if (first) { first = false; ready.resolve(); await release.promise; } return { id: 7, url: 'https://a.example/' }; },
      update: async (_id, details) => updates.push(details)
    },
    resolveNavigation: async () => ++resolveCount === 1 ? { redirectUrl: 'extension://test/old.html' } : null
  });
  const old = enforcer.enforce(7, 'https://a.example/');
  await ready.promise;
  await enforcer.enforce(7, 'https://b.example/');
  await enforcer.enforce(7, 'https://a.example/');
  release.resolve();
  await old;
  assert.deepEqual(updates, []);
});

for (const mode of ['blacklist', 'whitelist']) {
  test(`${mode} cleanup preserves a window if its new safety tab disappears before the final query`, async () => {
    await withCleanup([{ id: 1, windowId: 10, url: 'https://blocked.example/' }], async ({
      api, closeTabsMatchingRules, closeNonWhitelistedTabs
    }) => {
      const create = api.tabs.create;
      api.tabs.create = async details => {
        const tab = await create(details);
        api.tabs.values = api.tabs.values.filter(candidate => candidate.id !== tab.id);
        return tab;
      };
      if (mode === 'blacklist') await closeTabsMatchingRules(['blocked.example']);
      else await closeNonWhitelistedTabs(allowed);
      assert.deepEqual(api.removedTabs, []);
      assert.deepEqual(api.closedWindows, []);
      assert.equal(api.createdTabs.length, 1);
      assert.equal(api.tabs.values[0].id, 1);
    });
  });
}

test('a vanished SPA tab returns tab_unavailable without redirecting another tab', async () => {
  const enforcer = createSpaNavigationEnforcer({
    tabsApi: { get: async () => { throw new Error('No tab'); }, update: async () => assert.fail('unexpected redirect') },
    resolveNavigation: async () => ({ redirectUrl: 'extension://test/blocked.html' })
  });
  assert.equal((await enforcer.enforce(7, 'https://blocked.example/')).status, 'tab_unavailable');
});

for (const mode of ['blacklist', 'whitelist']) {
  test(`${mode} cleanup protects the destination window when a candidate moves during safety creation`, async () => {
    await withCleanup([
      { id: 1, windowId: 10, url: 'https://blocked.example/' },
      { id: 2, windowId: 30, url: 'https://allowed.example/' }
    ], async ({ api, closeTabsMatchingRules, closeNonWhitelistedTabs }) => {
      const create = api.tabs.create;
      api.tabs.create = async details => {
        const tab = await create(details);
        if (details.windowId === 10) {
          api.tabs.values.find(candidate => candidate.id === 1).windowId = 30;
          api.tabs.values = api.tabs.values.filter(candidate => candidate.id !== 2);
        }
        return tab;
      };
      if (mode === 'blacklist') await closeTabsMatchingRules(['blocked.example']);
      else await closeNonWhitelistedTabs(allowed);
      assert.deepEqual(api.removedTabs, [1]);
      assert.deepEqual(api.closedWindows, []);
      assert.deepEqual(api.createdTabs.map(details => details.windowId), [10, 30]);
    });
  });
}
