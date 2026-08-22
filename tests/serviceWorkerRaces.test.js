import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const TEST_FIREFOX_ANDROID = /firefox/i.test(process.cwd());
let workerImportId = 0;

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sendWorkerMessage(listener, message) {
  return new Promise((resolve, reject) => {
    if (listener(message, {}, resolve) !== true) {
      reject(new Error('Worker did not keep its response channel open: ' + message.type));
    }
  });
}

async function withWorker(callback, { credentials = {}, local = {} } = {}) {
  const api = createExtensionApi({
    sync: {
      settings: { mode: 'normal', debugMode: false, focusSessionSound: false },
      credentials: {
        isPro: true,
        licenseKey: 'BD-OLD-KEY',
        installationDate: '2026-08-01T00:00:00.000Z',
        isLegacyUser: false,
        ...credentials
      }
    },
    local: {
      rules: [],
      ruleLists: [
        { id: 'general', name: 'General', disabledCategories: [] },
        { id: 'list-1', name: 'Study', disabledCategories: [] }
      ],
      activeRuleListId: 'list-1',
      focusSession: {
        focusActive: false,
        focusEndTime: 0,
        isHardcore: false,
        focusMode: 'blacklist'
      },
      ...local
    }
  });

  api.runtime.onStartup = createEvent();
  api.runtime.onInstalled = createEvent();
  api.runtime.onMessage = createEvent();
  api.tabs.onUpdated = createEvent();
  api.tabs.onActivated = createEvent();
  api.tabs.onCreated = createEvent();
  api.tabs.get = async id => api.tabs.values.find(tab => tab.id === id) || { id };
  api.contextMenuPresent = false;
  api.contextMenus = {
    onClicked: createEvent(),
    remove(_id, callback) {
      api.contextMenuPresent = false;
      callback?.();
    },
    create(_details, callback) {
      api.contextMenuPresent = true;
      callback?.();
    }
  };
  api.alarmValues = new Map();
  api.alarms = {
    onAlarm: createEvent(),
    get(name, callback) {
      const alarm = api.alarmValues.get(name);
      callback?.(alarm);
      return Promise.resolve(alarm);
    },
    create(name, details) {
      api.alarmValues.set(name, { name, ...details });
      return Promise.resolve();
    },
    clear(name) {
      api.alarmValues.delete(name);
      return Promise.resolve(true);
    }
  };
  api.permissions = {
    onAdded: createEvent(),
    onRemoved: createEvent(),
    contains: async () => true,
    getAll: async () => ({ data_collection: ['technicalAndInteraction'] })
  };
  api.declarativeNetRequest = {
    getDynamicRules: async () => [],
    updateDynamicRules: async () => {}
  };
  api.notificationsCreated = [];
  api.notifications = {
    create(id, details) {
      api.notificationsCreated.push({ id, details });
    }
  };
  if (!TEST_FIREFOX_ANDROID) {
    api.windows = {
      WINDOW_ID_NONE: -1,
      onFocusChanged: createEvent()
    };
  }

  let fetchHandler = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ isPro: true })
  });
  api.setFetchHandler = handler => {
    fetchHandler = handler;
  };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (...args) => fetchHandler(...args);
  try {
    await withExtensionEnvironment(api, async () => {
      workerImportId += 1;
      await import('../scripts/service_worker.js?workerRace=' + workerImportId);
      assert.equal(api.runtime.onMessage.listeners.length, 1);
      if (TEST_FIREFOX_ANDROID) assert.equal(api.windows, undefined);
      await callback({
        api,
        send: message => sendWorkerMessage(api.runtime.onMessage.listeners[0], message),
        alarm: alarm => api.alarms.onAlarm.listeners[0](alarm)
      });
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('a license response received after logout cannot restore the old Pro key', async () => {
  await withWorker(async ({ api, send }) => {
    const requestStarted = createDeferred();
    const response = createDeferred();
    api.setFetchHandler(async () => {
      requestStarted.resolve();
      return response.promise;
    });

    const verification = send({ type: 'force_sync' });
    await requestStarted.promise;

    const logout = await send({
      type: 'update_pro_status',
      isPro: false,
      subscriptionData: { licenseKey: null, subscriptionEmail: null, expiryDate: null }
    });
    assert.equal(logout.success, true);

    response.resolve({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'old@example.com' })
    });
    await verification;

    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.equal(api.contextMenuPresent, false);
  });
});

test('rejection of an old license cannot clear a newly activated valid license', async () => {
  await withWorker(async ({ api, send }) => {
    const requestStarted = createDeferred();
    const response = createDeferred();
    api.setFetchHandler(async () => {
      requestStarted.resolve();
      return response.promise;
    });

    const verification = send({ type: 'force_sync' });
    await requestStarted.promise;

    const activation = await send({
      type: 'update_pro_status',
      isPro: true,
      subscriptionData: {
        licenseKey: 'BD-NEW-KEY',
        subscriptionEmail: 'new@example.com'
      }
    });
    assert.equal(activation.success, true);

    response.resolve({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Old key rejected' })
    });
    await verification;

    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-NEW-KEY');
    assert.equal(api.storage.sync.data.credentials.subscriptionEmail, 'new@example.com');
    assert.equal(api.contextMenuPresent, true);
  });
});

test('an older response for the same license cannot override a newer verification', async () => {
  await withWorker(async ({ api, send }) => {
    const requests = [];
    const bothRequestsStarted = createDeferred();
    api.setFetchHandler(async () => {
      const response = createDeferred();
      requests.push(response);
      if (requests.length === 2) bothRequestsStarted.resolve();
      return response.promise;
    });

    const older = send({ type: 'force_sync' });
    const newer = send({ type: 'force_sync' });
    await bothRequestsStarted.promise;

    requests[1].resolve({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'current@example.com' })
    });
    await newer;

    requests[0].resolve({
      ok: true,
      status: 200,
      json: async () => ({ isPro: false })
    });
    await older;

    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
    assert.equal(api.storage.sync.data.credentials.subscriptionEmail, 'current@example.com');
  });
});

test('an overlapping downgrade cannot overwrite a newer Pro upgrade or its active list', async () => {
  await withWorker(async ({ api, send }) => {
    const pauseStarted = createDeferred();
    const releasePause = createDeferred();
    const originalSet = api.storage.local.set.bind(api.storage.local);
    let pauseBlocked = false;
    api.storage.local.set = async values => {
      if (!pauseBlocked && values.dailyRuleUsage) {
        pauseBlocked = true;
        pauseStarted.resolve();
        await releasePause.promise;
      }
      return originalSet(values);
    };

    const downgrade = send({
      type: 'update_pro_status',
      isPro: false,
      subscriptionData: { licenseKey: null }
    });
    await pauseStarted.promise;

    const upgrade = send({
      type: 'update_pro_status',
      isPro: true,
      subscriptionData: { licenseKey: 'BD-RESTORED-KEY' }
    });
    await Promise.resolve();
    await Promise.resolve();
    releasePause.resolve();
    await Promise.all([downgrade, upgrade]);

    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-RESTORED-KEY');
    assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
    assert.equal(api.contextMenuPresent, true);
  });
});

test('a delayed focus-session start cannot reactivate a session after a newer stop', async () => {
  await withWorker(async ({ api, send }) => {
    const startWriteStarted = createDeferred();
    const releaseStartWrite = createDeferred();
    const originalSet = api.storage.local.set.bind(api.storage.local);
    let blockedStartWrite = false;
    api.storage.local.set = async values => {
      if (!blockedStartWrite && values.focusSession?.focusActive === true) {
        blockedStartWrite = true;
        startWriteStarted.resolve();
        await releaseStartWrite.promise;
      }
      return originalSet(values);
    };

    const started = send({ type: 'start_focus_session', duration: 5 });
    await startWriteStarted.promise;
    const stopped = send({ type: 'stop_focus_session' });
    await new Promise(resolve => setImmediate(resolve));
    releaseStartWrite.resolve();
    await Promise.all([started, stopped]);

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
  });
});

test('a stale alarm from an earlier focus session cannot end a newer session', async () => {
  await withWorker(async ({ api, send, alarm }) => {
    await send({ type: 'start_focus_session', duration: 1 });
    const staleEndTime = api.storage.local.data.focusSession.focusEndTime;
    await send({ type: 'stop_focus_session' });
    await send({ type: 'start_focus_session', duration: 10 });
    const currentEndTime = api.storage.local.data.focusSession.focusEndTime;

    await alarm({ name: 'end_focus_session', scheduledTime: staleEndTime });

    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.storage.local.data.focusSession.focusEndTime, currentEndTime);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);
    assert.equal(api.notificationsCreated.length, 0);
  });
});

test('an alarm delivered after a focus session was stopped is ignored', async () => {
  await withWorker(async ({ api, send, alarm }) => {
    await send({ type: 'start_focus_session', duration: 3 });
    const scheduledTime = api.storage.local.data.focusSession.focusEndTime;
    await send({ type: 'stop_focus_session' });

    await alarm({ name: 'end_focus_session', scheduledTime });

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);
    assert.equal(api.notificationsCreated.length, 0);
  });
});
