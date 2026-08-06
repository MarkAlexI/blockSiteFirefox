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

function normalizeKeys(keys, data) {
  if (keys === null || keys === undefined) return Object.keys(data);
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  return Object.keys(keys);
}

function createStorageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get(keys, callback) {
      const result = {};
      for (const key of normalizeKeys(keys, data)) {
        if (key in data) result[key] = structuredClone(data[key]);
      }
      if (typeof callback === 'function') {
        callback(result);
        return undefined;
      }
      return Promise.resolve(result);
    },
    set(values, callback) {
      Object.assign(data, structuredClone(values));
      if (typeof callback === 'function') callback();
      return Promise.resolve();
    }
  };
}

function sendWorkerMessage(listener, message) {
  return new Promise((resolve, reject) => {
    const keepChannelOpen = listener(message, {}, resolve);
    if (keepChannelOpen !== true) {
      reject(new Error(`Message ${message.type} did not keep the response channel open`));
    }
  });
}

test('service worker module loads, registers listeners, and serves privacy-safe diagnostics', async () => {
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

  const localStorage = createStorageArea({
    rules: [{
      id: 1,
      blockURL: 'private.example',
      redirectURL: '',
      category: 'social',
      schedule: null,
      disabledByUser: false,
      isWhitelist: false
    }],
    focusSession: {
      focusActive: false,
      focusEndTime: 0,
      isHardcore: false,
      focusMode: 'blacklist'
    },
    diagnosticEvents: [{
      timestamp: 1,
      level: 'error',
      source: 'test',
      code: 'private_event',
      details: {
        url: 'https://private.example/path',
        message: 'Failed at https://private.example/path'
      }
    }]
  });
  const syncStorage = createStorageArea({
    settings: {
      mode: 'normal',
      debugMode: true,
      disabledCategories: []
    },
    credentials: {
      isPro: true,
      isLegacyUser: false,
      installationDate: '2026-08-01T00:00:00.000Z',
      licenseKey: 'BD-PRIVATE-123456'
    }
  });

  globalThis.browser = {
    storage: {
      local: localStorage,
      sync: syncStorage,
      onChanged: createEvent()
    },
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getURL: path => `moz-extension://test-extension-id/${path}`,
      getManifest: () => ({ version: '4.7.0', manifest_version: 3 }),
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
    assert.equal(tabsOnActivated.listeners.length, 0);
    assert.equal(contextMenusOnClicked.listeners.length, 1);
    assert.equal(permissionsOnRemoved.listeners.length, 1);
    assert.deepEqual(
      createdAlarms.map(alarm => alarm.name),
      ['check_pro_expiry', 'update_scheduled_rules']
    );

    const messageListener = runtimeOnMessage.listeners[0];
    const diagnostics = await sendWorkerMessage(messageListener, {
      type: 'diagnostics:getReport'
    });

    assert.equal(diagnostics.success, true);
    assert.equal(diagnostics.report.extension.version, '4.7.0');
    assert.equal(diagnostics.report.rules.total, 1);
    assert.equal(diagnostics.report.dnr.inSync, false);
    assert.equal(diagnostics.report.permissions.hostAccess, true);
    assert.equal(diagnostics.report.recentEvents[0].details.url, '<redacted>');
    assert.equal(
      diagnostics.report.recentEvents[0].details.message.includes('private.example'),
      false
    );
    assert.equal(JSON.stringify(diagnostics.report).includes('BD-PRIVATE'), false);

    const cleared = await sendWorkerMessage(messageListener, {
      type: 'diagnostics:clearHistory'
    });
    assert.equal(cleared.success, true);
    assert.deepEqual(localStorage.data.diagnosticEvents, []);
  } finally {
    globalThis.browser = previousChrome;
    globalThis.DebugController = previousDebugController;
  }
});
