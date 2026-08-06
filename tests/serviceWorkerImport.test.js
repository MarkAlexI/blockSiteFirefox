import test from 'node:test';
import assert from 'node:assert/strict';

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function createStorageArea() {
  return {
    get(_keys, callback) {
      const result = {};
      if (typeof callback === 'function') {
        callback(result);
        return undefined;
      }
      return Promise.resolve(result);
    },
    set(_values, callback) {
      if (typeof callback === 'function') callback();
      return Promise.resolve();
    }
  };
}

test('service worker module loads and registers its browser listeners', async () => {
  const previousChrome = globalThis.browser;
  const previousDebugController = globalThis.DebugController;
  const createdAlarms = [];

  const runtimeOnStartup = createEvent();
  const runtimeOnInstalled = createEvent();
  const runtimeOnMessage = createEvent();
  const alarmsOnAlarm = createEvent();
  const tabsOnUpdated = createEvent();
  const tabsOnCreated = createEvent();
  const tabsOnActivated = createEvent();
  const contextMenusOnClicked = createEvent();
  const permissionsOnRemoved = createEvent();

  globalThis.browser = {
    storage: {
      local: createStorageArea(),
      sync: createStorageArea(),
      onChanged: createEvent()
    },
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getURL: path => `chrome-extension://test-extension-id/${path}`,
      getManifest: () => ({ version: '4.5.0' }),
      setUninstallURL() {},
      sendMessage(_message, callback) {
        if (typeof callback === 'function') callback();
      },
      onStartup: runtimeOnStartup,
      onInstalled: runtimeOnInstalled,
      onMessage: runtimeOnMessage
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {}
    },
    alarms: {
      get(_name, callback) {
        callback(null);
      },
      create(name, options) {
        createdAlarms.push({ name, options });
      },
      clear: async () => true,
      onAlarm: alarmsOnAlarm
    },
    tabs: {
      query: async () => [],
      create: async () => ({}),
      remove: async () => {},
      onUpdated: tabsOnUpdated,
      onCreated: tabsOnCreated,
      onActivated: tabsOnActivated
    },
    contextMenus: {
      remove(_id, callback) {
        if (typeof callback === 'function') callback();
      },
      create(_options, callback) {
        if (typeof callback === 'function') callback();
      },
      onClicked: contextMenusOnClicked
    },
    permissions: {
      contains: async () => true,
      onRemoved: permissionsOnRemoved
    },
    notifications: {
      create() {}
    },
    i18n: {
      getMessage: key => key
    }
  };

  try {
    await import(`../scripts/service_worker.js?test=${Date.now()}`);

    assert.equal(runtimeOnStartup.listeners.length, 1);
    assert.equal(runtimeOnInstalled.listeners.length, 1);
    assert.equal(runtimeOnMessage.listeners.length, 1);
    assert.equal(alarmsOnAlarm.listeners.length, 1);
    assert.equal(tabsOnUpdated.listeners.length, 1);
    assert.equal(tabsOnCreated.listeners.length, 1);
    assert.equal(tabsOnActivated.listeners.length, 1);
    assert.equal(contextMenusOnClicked.listeners.length, 1);
    assert.equal(permissionsOnRemoved.listeners.length, 1);
    assert.deepEqual(
      createdAlarms.map(alarm => alarm.name),
      ['check_pro_expiry', 'update_scheduled_rules']
    );
  } finally {
    globalThis.browser = previousChrome;
    globalThis.DebugController = previousDebugController;
  }
});
