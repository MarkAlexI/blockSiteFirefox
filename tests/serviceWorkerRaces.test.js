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

function makeFocusRule(id, listId, { blockURL = null, isWhitelist = false } = {}) {
  return {
    id,
    blockURL: blockURL || `${listId}-${id}.example`,
    redirectURL: '',
    category: isWhitelist ? 'whitelist' : 'social',
    isWhitelist,
    assignments: [{
      listId: isWhitelist ? 'general' : listId,
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    }]
  };
}

function sendWorkerMessage(listener, message) {
  return new Promise((resolve, reject) => {
    if (listener(message, {}, resolve) !== true) {
      reject(new Error('Worker did not keep its response channel open: ' + message.type));
    }
  });
}

async function withWorker(callback, {
  credentials = {},
  local = {},
  supportsWindows = !TEST_FIREFOX_ANDROID
} = {}) {
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
  api.dynamicRules = [];
  api.dnrUpdates = [];
  api.declarativeNetRequest = {
    getDynamicRules: async () => structuredClone(api.dynamicRules),
    updateDynamicRules: async update => {
      api.dnrUpdates.push(structuredClone(update));
      const removed = new Set(update.removeRuleIds || []);
      api.dynamicRules = api.dynamicRules.filter(rule => !removed.has(rule.id));
      api.dynamicRules.push(...structuredClone(update.addRules || []));
    }
  };
  api.notificationsCreated = [];
  api.notifications = {
    create(id, details) {
      api.notificationsCreated.push({ id, details });
    }
  };
  if (supportsWindows) {
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
      if (!supportsWindows) assert.equal(api.windows, undefined);
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

test('the worker remains available when the optional windows API is missing', async () => {
  await withWorker(async ({ api, send }) => {
    assert.equal(api.windows, undefined);
    const response = await send({ type: 'start_focus_session', duration: 25 });
    assert.equal(response.success, true);
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
  }, { supportsWindows: false });
});

test('Free users can start the standard 25-minute Focus Session', async () => {
  await withWorker(async ({ api, send }) => {
    const before = Date.now();
    const response = await send({ type: 'start_focus_session' });
    const session = api.storage.local.data.focusSession;

    assert.equal(response.success, true);
    assert.equal(session.focusActive, true);
    assert.equal(session.focusMode, 'blacklist');
    assert.equal(session.isHardcore, false);
    assert.equal(session.focusEndTime >= before + 25 * 60 * 1000, true);
    assert.equal(session.focusEndTime <= Date.now() + 25 * 60 * 1000, true);
    assert.equal(api.alarmValues.has('end_focus_session'), true);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' }
  });
});

test('Free Focus rejects custom duration, Hardcore, and Whitelist before changing state', async () => {
  await withWorker(async ({ api, send }) => {
    for (const request of [
      { duration: 1 },
      { duration: 24 },
      { duration: 26 },
      { duration: 240 },
      { duration: 25, isHardcore: true },
      { duration: 25, focusMode: 'whitelist' }
    ]) {
      const response = await send({ type: 'start_focus_session', ...request });
      assert.deepEqual(response, {
        success: false,
        error: 'pro_required',
        code: 'pro_required'
      });
      assert.equal(api.storage.local.data.focusSession.focusActive, false);
      assert.equal(api.alarmValues.has('end_focus_session'), false);
      assert.deepEqual(api.dynamicRules, []);
      assert.equal(api.storage.local.data.telemetryBuckets, undefined);
    }
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' }
  });
});

test('the worker rejects malformed Focus durations, modes, and Hardcore values', async () => {
  await withWorker(async ({ api, send }) => {
    for (const duration of [0, -1, 241, 2.5, '25', Number.NaN, Number.POSITIVE_INFINITY]) {
      const response = await send({ type: 'start_focus_session', duration });
      assert.equal(response.success, false);
      assert.equal(response.code, 'invalid_focus_duration');
    }

    for (const focusMode of ['', 'BLACKLIST', 'other', true]) {
      const response = await send({ type: 'start_focus_session', focusMode });
      assert.equal(response.success, false);
      assert.equal(response.code, 'invalid_focus_mode');
    }

    for (const isHardcore of ['true', 1, {}]) {
      const response = await send({ type: 'start_focus_session', isHardcore });
      assert.equal(response.success, false);
      assert.equal(response.code, 'invalid_focus_hardcore');
    }

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
  });
});

test('a malformed Focus request cannot supersede a valid session already being started', async () => {
  await withWorker(async ({ api, send }) => {
    const writeStarted = createDeferred();
    const releaseWrite = createDeferred();
    const originalSet = api.storage.local.set.bind(api.storage.local);
    let delayed = false;
    api.storage.local.set = async values => {
      if (!delayed && values.focusSession?.focusActive === true) {
        delayed = true;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return originalSet(values);
    };

    const starting = send({ type: 'start_focus_session', duration: 5 });
    await writeStarted.promise;
    const rejected = await send({ type: 'start_focus_session', duration: 0 });
    releaseWrite.resolve();
    const started = await starting;

    assert.equal(rejected.code, 'invalid_focus_duration');
    assert.equal(started.success, true);
    assert.equal(started.superseded, undefined);
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
  });
});

test('both Pro and legacy access can start all paid Focus configurations', async () => {
  for (const credentials of [
    { isPro: true, installationDate: '2026-08-01T00:00:00.000Z' },
    {
      isPro: false,
      isLegacyUser: true,
      licenseKey: null,
      installationDate: '2025-12-01T00:00:00.000Z'
    }
  ]) {
    await withWorker(async ({ api, send }) => {
      const response = await send({
        type: 'start_focus_session',
        duration: 240,
        isHardcore: true,
        focusMode: 'whitelist'
      });

      assert.equal(response.success, true);
      assert.equal(api.storage.local.data.focusSession.focusMode, 'whitelist');
      assert.equal(api.storage.local.data.focusSession.isHardcore, true);
    }, { credentials });
  }
});

test('Free worker Focus activates only General even while storage points to Study', async () => {
  const rules = [
    makeFocusRule(101, 'general', { blockURL: 'general.example' }),
    makeFocusRule(102, 'list-1', { blockURL: 'study.example' })
  ];

  await withWorker(async ({ api, send }) => {
    const response = await send({ type: 'start_focus_session', duration: 25 });

    assert.equal(response.success, true);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [101]);
    assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.id), [101, 102]);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { rules, activeRuleListId: 'list-1' }
  });
});

test('Pro downgrade unlocks Hardcore Whitelist Focus and keeps only General browser rules', async () => {
  const rules = [
    makeFocusRule(111, 'general', { blockURL: 'general.example' }),
    makeFocusRule(112, 'list-1', { blockURL: 'study.example' })
  ];

  await withWorker(async ({ api, send }) => {
    const started = await send({
      type: 'start_focus_session',
      duration: 40,
      isHardcore: true,
      focusMode: 'whitelist'
    });
    const originalDeadline = api.storage.local.data.focusSession.focusEndTime;
    assert.equal(started.success, true);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [111, 112]);

    const downgraded = await send({
      type: 'update_pro_status',
      isPro: false,
      subscriptionData: { licenseKey: null }
    });

    assert.equal(downgraded.success, true);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.deepEqual(api.storage.local.data.focusSession, {
      focusActive: true,
      focusEndTime: originalDeadline,
      isHardcore: false,
      focusMode: 'blacklist'
    });
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [111]);
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.id), [111, 112]);
    assert.equal(api.alarmValues.has('end_focus_session'), true);
  }, { local: { rules, activeRuleListId: 'list-1' } });
});

test('downgrade resynchronizes active Focus even when General was already selected', async () => {
  const rules = [
    makeFocusRule(121, 'general', { blockURL: 'general.example' }),
    makeFocusRule(122, 'list-1', { blockURL: 'study.example' })
  ];

  await withWorker(async ({ api, send }) => {
    await send({ type: 'start_focus_session', duration: 25 });
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [121, 122]);

    await send({
      type: 'update_pro_status',
      isPro: false,
      subscriptionData: { licenseKey: null }
    });

    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [121]);
  }, { local: { rules, activeRuleListId: 'general' } });
});

test('legacy users keep paid Focus settings and custom lists after their Pro flag changes', async () => {
  const rules = [
    makeFocusRule(131, 'general', { blockURL: 'general.example' }),
    makeFocusRule(132, 'list-1', { blockURL: 'study.example' })
  ];

  await withWorker(async ({ api, send }) => {
    await send({
      type: 'start_focus_session',
      duration: 45,
      isHardcore: true,
      focusMode: 'whitelist'
    });
    await send({
      type: 'update_pro_status',
      isPro: false,
      subscriptionData: { licenseKey: null }
    });

    assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
    assert.equal(api.storage.local.data.focusSession.focusMode, 'whitelist');
    assert.equal(api.storage.local.data.focusSession.isHardcore, true);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [131, 132]);
  }, {
    credentials: {
      isPro: true,
      isLegacyUser: true,
      installationDate: '2025-12-01T00:00:00.000Z'
    },
    local: { rules, activeRuleListId: 'list-1' }
  });
});

test('worker Whitelist Focus closes lookalike sites and protected-name bypass URLs', async () => {
  const rules = [
    makeFocusRule(141, 'general', { blockURL: 'allowed.example', isWhitelist: true })
  ];

  await withWorker(async ({ api, send }) => {
    api.tabs.values.push(
      { id: 1, url: 'https://allowed.example/' },
      { id: 2, url: 'https://notallowed.example/' },
      { id: 3, url: 'https://evil.example/?next=blockdistraction.com' },
      { id: 4, url: 'https://blockdistraction.com/account.html' }
    );

    const response = await send({
      type: 'start_focus_session',
      duration: 5,
      focusMode: 'whitelist'
    });
    assert.equal(response.success, true);
    assert.deepEqual(api.removedTabs, [2, 3]);

    await api.tabs.onUpdated.listeners[0](9, {
      url: 'https://evil.example/?next=allowed.example'
    }, { id: 9, active: false, url: 'https://evil.example/?next=allowed.example' });
    assert.deepEqual(api.removedTabs, [2, 3, 9]);
  }, { local: { rules, activeRuleListId: 'general' } });
});
