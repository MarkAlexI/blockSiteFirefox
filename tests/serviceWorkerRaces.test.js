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
  settings = {},
  local = {},
  supportsWindows = !TEST_FIREFOX_ANDROID
} = {}) {
  const api = createExtensionApi({
    sync: {
      settings: { mode: 'normal', debugMode: false, focusSessionSound: false, ...settings },
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
  api.contextMenuDetails = null;
  api.contextMenus = {
    onClicked: createEvent(),
    remove(_id, callback) {
      api.contextMenuPresent = false;
      api.contextMenuDetails = null;
      callback?.();
    },
    create(details, callback) {
      api.contextMenuPresent = true;
      api.contextMenuDetails = structuredClone(details);
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
        alarm: alarm => api.alarms.onAlarm.listeners[0](alarm),
        startup: () => api.runtime.onStartup.listeners[0]()
      });
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('minute watchdog preserves checks without rewriting unchanged inactive storage', async () => {
  await withWorker(async ({ api, alarm }) => {
    let permissionChecks = 0;
    let dnrReads = 0;
    const localWrites = [];
    const originalPermissionCheck = api.permissions.contains;
    const originalDnrRead = api.declarativeNetRequest.getDynamicRules;
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.permissions.contains = async (...args) => {
      permissionChecks++;
      return originalPermissionCheck(...args);
    };
    api.declarativeNetRequest.getDynamicRules = async (...args) => {
      dnrReads++;
      return originalDnrRead(...args);
    };
    api.storage.local.set = (values, callback) => {
      localWrites.push(Object.keys(values));
      return originalSet(values, callback);
    };

    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
    localWrites.length = 0;

    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(localWrites, []);
    assert.equal(permissionChecks, 2);
    assert.equal(dnrReads, 2);
  }, { supportsWindows: false });
});

test('a committed rule remains successful when its telemetry write is rejected', async () => {
  await withWorker(async ({ api, send }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => {
      if (Object.hasOwn(values, 'telemetryBuckets')) {
        return Promise.reject(new Error('telemetry storage quota exceeded'));
      }
      return originalSet(values, callback);
    };

    const response = await send({
      type: 'rules:add',
      payload: { blockURL: 'committed.example', redirectURL: '', category: 'social' }
    });

    assert.equal(response.success, true);
    assert.equal(response.rule.blockURL, 'committed.example');
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.id), [response.rule.id]);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [response.rule.id]);
  }, {
    local: {
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('Daily Limit cleanup failure cannot undo a committed rule or skip its follow-up sample', async () => {
  await withWorker(async ({ api, send }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    const originalQuery = api.tabs.query.bind(api.tabs);
    let dailyReads = 0;
    let activeSamples = 0;
    api.storage.local.get = (keys, callback) => {
      if (keys === 'dailyRuleUsage' && ++dailyReads === 2) {
        return Promise.reject(new Error('Daily Limit cleanup unavailable'));
      }
      return originalGet(keys, callback);
    };
    api.tabs.query = (query, callback) => {
      if (query?.active === true) activeSamples += 1;
      return originalQuery(query, callback);
    };

    const response = await send({
      type: 'rules:add',
      payload: { blockURL: 'cleanup-failure.example', redirectURL: '', category: 'social' }
    });

    assert.equal(response.success, true);
    assert.equal(activeSamples, 1);
    assert.equal(dailyReads >= 3, true);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [response.rule.id]);
    assert.equal(Object.values(api.storage.local.data.telemetryBuckets)[0].counters.rule_created, 1);
  }, {
    local: {
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('a failed Daily Limit sample cannot turn a committed rule into a failed mutation', async () => {
  await withWorker(async ({ api, send }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let dailyReads = 0;
    api.storage.local.get = (keys, callback) => {
      if (keys === 'dailyRuleUsage' && ++dailyReads === 3) {
        return Promise.reject(new Error('Daily Limit sample unavailable'));
      }
      return originalGet(keys, callback);
    };

    const response = await send({
      type: 'rules:add',
      payload: { blockURL: 'sample-failure.example', redirectURL: '', category: 'social' }
    });

    assert.equal(response.success, true);
    assert.equal(dailyReads, 3);
    assert.equal(api.storage.local.data.rules[0].blockURL, 'sample-failure.example');
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [response.rule.id]);
  }, { local: { activeRuleListId: 'general' }, supportsWindows: false });
});

test('failed rule mutations still respond when diagnostics and telemetry both reject', async () => {
  await withWorker(async ({ api, send }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    const rejectedWrites = [];
    api.storage.local.set = (values, callback) => {
      for (const key of ['diagnosticEvents', 'telemetryBuckets']) {
        if (Object.hasOwn(values, key)) {
          rejectedWrites.push(key);
          return Promise.reject(new Error(key + ' storage write rejected'));
        }
      }
      return originalSet(values, callback);
    };

    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await send({ type: 'rules:delete', payload: { ruleId: 404 } });
      assert.equal(response.success, false);
      assert.equal(response.error.code, 'rule_not_found');
      assert.deepEqual(new Set(rejectedWrites), new Set(['diagnosticEvents', 'telemetryBuckets']));
    } finally {
      console.error = originalError;
    }
  }, {
    settings: { debugMode: true },
    local: { telemetryConsent: { version: 1, enabled: true, decidedAt: 1 } },
    supportsWindows: false
  });
});

test('expected validation failures keep their original response if diagnostic history cannot be saved', async () => {
  await withWorker(async ({ api, send }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => Object.hasOwn(values, 'diagnosticEvents')
      ? Promise.reject(new Error('diagnostic history unavailable'))
      : originalSet(values, callback);

    const response = await send({
      type: 'rules:add',
      payload: {
        blockURL: 'invalid-redirect.example',
        redirectURL: 'not a valid redirect',
        category: 'social'
      }
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, 'validation_failed');
    assert.deepEqual(response.error.validationErrors, ['redirect_invalid']);
    assert.equal(api.storage.local.data.telemetryBuckets, undefined);
  }, { settings: { debugMode: true }, supportsWindows: false });
});

test('recent license checks never skip startup Free recovery, Daily Limit sampling, or DNR repair', async () => {
  const recentCheck = Date.now();
  const rules = [
    makeFocusRule(201, 'general', { blockURL: 'general-startup.example' }),
    makeFocusRule(202, 'list-1', { blockURL: 'study-startup.example' })
  ];

  await withWorker(async ({ api, startup }) => {
    const originalQuery = api.tabs.query.bind(api.tabs);
    let licenseRequests = 0;
    let activeSamples = 0;
    let permissionChecks = 0;
    api.setFetchHandler(async () => {
      licenseRequests += 1;
      return { ok: true, status: 200, json: async () => ({ isPro: false }) };
    });
    api.tabs.query = (query, callback) => {
      if (query?.active === true) activeSamples += 1;
      return originalQuery(query, callback);
    };
    api.permissions.contains = async () => {
      permissionChecks += 1;
      return true;
    };

    await startup();

    assert.equal(api.windows, undefined);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.id), [201, 202]);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [201]);
    assert.equal(permissionChecks, 1);
    assert.equal(activeSamples >= 1, true);
    assert.equal(licenseRequests, 0);
    assert.equal(api.storage.local.data.lastCheck, recentCheck);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { rules, activeRuleListId: 'list-1', lastCheck: recentCheck },
    supportsWindows: false
  });
});

test('a throttled Pro startup still replaces stale browser rules without contacting the license server', async () => {
  const recentCheck = Date.now();
  const rules = [makeFocusRule(211, 'general', { blockURL: 'repaired-startup.example' })];
  await withWorker(async ({ api, startup }) => {
    api.dynamicRules = [{
      id: 999,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: 'stale.example', resourceTypes: ['main_frame'] }
    }];
    let licenseRequests = 0;
    api.setFetchHandler(async () => {
      licenseRequests += 1;
      throw new Error('throttled license check must not run');
    });

    await startup();

    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [211]);
    assert.equal(api.dnrUpdates.some(update => update.removeRuleIds.includes(999)), true);
    assert.equal(api.contextMenuPresent, true);
    assert.equal(licenseRequests, 0);
    assert.equal(api.storage.local.data.lastCheck, recentCheck);
  }, { local: { rules, activeRuleListId: 'general', lastCheck: recentCheck }, supportsWindows: false });
});

test('newly restored legacy access cannot be overwritten by an older Free startup snapshot', async () => {
  await withWorker(async ({ api, startup }) => {
    const originalGet = api.storage.sync.get.bind(api.storage.sync);
    let credentialReads = 0;
    api.storage.sync.get = (keys, callback) => {
      if (Array.isArray(keys) && keys.includes('credentials') && ++credentialReads === 3) {
        api.storage.sync.data.credentials.installationDate = '2025-12-01T00:00:00.000Z';
        api.storage.sync.data.credentials.isLegacyUser = true;
      }
      return originalGet(keys, callback);
    };

    await startup();

    assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
    assert.equal(api.contextMenuPresent, true);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { lastCheck: Date.now() },
    supportsWindows: false
  });
});

test('missing and expired license timestamps still perform one startup license verification', async () => {
  for (const lastCheck of [undefined, Date.now() - 12 * 60 * 60 * 1000 - 1]) {
    await withWorker(async ({ api, startup }) => {
      let requests = 0;
      api.setFetchHandler(async () => {
        requests += 1;
        return { ok: true, status: 200, json: async () => ({ isPro: true }) };
      });

      await startup();

      assert.equal(requests, 1);
      assert.equal(typeof api.storage.local.data.lastCheck, 'number');
      assert.equal(api.storage.local.data.lastCheck > (lastCheck || 0), true);
      assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    }, {
      local: { activeRuleListId: 'general', ...(lastCheck === undefined ? {} : { lastCheck }) },
      supportsWindows: false
    });
  }
});

test('a failed telemetry retry restoration cannot prevent startup DNR reconciliation', async () => {
  const rules = [makeFocusRule(221, 'general', { blockURL: 'retry-recovery.example' })];
  await withWorker(async ({ api, startup }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let retryReads = 0;
    api.storage.local.get = (keys, callback) => {
      if (Array.isArray(keys) && keys.includes('telemetryDeliveryState')) {
        retryReads += 1;
        return Promise.reject(new Error('telemetry delivery state unavailable'));
      }
      return originalGet(keys, callback);
    };

    await startup();

    assert.equal(retryReads, 1);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [221]);
  }, {
    local: {
      rules,
      activeRuleListId: 'general',
      lastCheck: Date.now(),
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('legacy access creates and authorizes the browser context menu without a Pro license', async () => {
  await withWorker(async ({ api, startup }) => {
    await startup();

    assert.equal(api.contextMenuPresent, true);
    assert.deepEqual(api.contextMenuDetails.contexts, TEST_FIREFOX_ANDROID ? ['link'] : ['page', 'link']);

    await api.contextMenus.onClicked.listeners[0]({
      menuItemId: 'blockDistraction',
      linkUrl: 'https://legacy-context.example/allowed'
    }, {});

    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.local.data.rules[0].blockURL, 'legacy-context.example/allowed');
  }, {
    credentials: {
      isPro: false,
      licenseKey: null,
      installationDate: '2025-12-01T00:00:00.000Z'
    },
    local: { activeRuleListId: 'general', lastCheck: Date.now() },
    supportsWindows: false
  });
});

test('credential read failures block paid worker actions while Free toggle and deletion remain available', async () => {
  const rules = [makeFocusRule(231, 'general', { blockURL: 'still-removable.example' })];
  await withWorker(async ({ api, send }) => {
    api.storage.sync.getError = new Error('sync storage unavailable');
    const originalError = console.error;
    console.error = () => {};
    try {
      const rejected = await send({ type: 'rules:createList', payload: { name: 'Unauthorized' } });
      assert.equal(rejected.success, false);
      assert.equal(rejected.error.code, 'rules_operation_failed');
      assert.deepEqual(api.storage.local.data.ruleLists.map(list => list.id), ['general', 'list-1']);

      const toggled = await send({
        type: 'rules:toggle',
        payload: { ruleId: 231, listId: 'general' }
      });
      assert.equal(toggled.success, true);
      assert.equal(api.storage.local.data.rules[0].assignments[0].disabledByUser, true);

      const removed = await send({
        type: 'rules:removeAssignment',
        payload: { ruleId: 231, listId: 'general' }
      });
      assert.equal(removed.success, true);
      assert.equal(removed.targetDeleted, true);
      assert.deepEqual(api.storage.local.data.rules, []);
      assert.deepEqual(api.dynamicRules, []);
    } finally {
      console.error = originalError;
    }
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { rules, activeRuleListId: 'general' },
    supportsWindows: false
  });
});

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
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let pauseBlocked = false;
    api.storage.local.get = async (...args) => {
      if (!pauseBlocked && args[0] === 'dailyRuleUsage') {
        pauseBlocked = true;
        pauseStarted.resolve();
        await releasePause.promise;
      }
      return originalGet(...args);
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

test('a Pro downgrade cannot be overtaken by a paid Focus start whose state write was delayed', async () => {
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

    const starting = send({
      type: 'start_focus_session',
      duration: 40,
      isHardcore: true,
      focusMode: 'whitelist'
    });
    await startWriteStarted.promise;

    const downgrading = send({
      type: 'update_pro_status',
      isPro: false,
      subscriptionData: { licenseKey: null }
    });
    for (let index = 0; index < 8; index++) {
      await new Promise(resolve => setImmediate(resolve));
    }

    releaseStartWrite.resolve();
    await Promise.all([starting, downgrading]);

    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.storage.local.data.focusSession.focusMode, 'blacklist');
    assert.equal(api.storage.local.data.focusSession.isHardcore, false);
  });
});

test('stopping Whitelist Focus cancels its pending initial tab cleanup', async () => {
  const rules = [
    makeFocusRule(91, 'general', { blockURL: 'allowed.example', isWhitelist: true })
  ];

  await withWorker(async ({ api, send }) => {
    api.tabs.values.push({ id: 19, windowId: 1, url: 'https://blocked.example/' });
    const queryStarted = createDeferred();
    const releaseQuery = createDeferred();
    const originalQuery = api.tabs.query.bind(api.tabs);
    let blockedCleanupQuery = false;
    api.tabs.query = async queryInfo => {
      if (!blockedCleanupQuery && Object.keys(queryInfo || {}).length === 0) {
        blockedCleanupQuery = true;
        queryStarted.resolve();
        await releaseQuery.promise;
      }
      return originalQuery(queryInfo);
    };

    const starting = send({
      type: 'start_focus_session',
      duration: 5,
      focusMode: 'whitelist'
    });
    await queryStarted.promise;

    const stopping = send({ type: 'stop_focus_session' });
    await new Promise(resolve => setImmediate(resolve));
    releaseQuery.resolve();
    await Promise.all([starting, stopping]);

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.deepEqual(api.removedTabs, []);
  }, { local: { rules, activeRuleListId: 'general' } });
});

test('a stop request is not lost when a Pro downgrade overlaps Whitelist cleanup', async () => {
  const rules = [
    makeFocusRule(92, 'general', { blockURL: 'allowed.example', isWhitelist: true })
  ];

  await withWorker(async ({ api, send }) => {
    const queryStarted = createDeferred();
    const releaseQuery = createDeferred();
    const originalQuery = api.tabs.query.bind(api.tabs);
    let blockedCleanupQuery = false;
    api.tabs.query = async queryInfo => {
      if (!blockedCleanupQuery && Object.keys(queryInfo || {}).length === 0) {
        blockedCleanupQuery = true;
        queryStarted.resolve();
        await releaseQuery.promise;
      }
      return originalQuery(queryInfo);
    };

    const starting = send({
      type: 'start_focus_session',
      duration: 5,
      isHardcore: true,
      focusMode: 'whitelist'
    });
    await queryStarted.promise;

    const stopping = send({ type: 'stop_focus_session' });
    const downgrading = send({
      type: 'update_pro_status',
      isPro: false,
      subscriptionData: { licenseKey: null }
    });
    for (let index = 0; index < 8; index++) {
      await new Promise(resolve => setImmediate(resolve));
    }

    releaseQuery.resolve();
    await Promise.all([starting, stopping, downgrading]);

    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
  }, { local: { rules, activeRuleListId: 'general' } });
});

test('a tab update cannot close a site after Whitelist Focus has stopped', async () => {
  const rules = [
    makeFocusRule(93, 'general', { blockURL: 'allowed.example', isWhitelist: true })
  ];

  await withWorker(async ({ api, send }) => {
    await send({
      type: 'start_focus_session',
      duration: 5,
      focusMode: 'whitelist'
    });

    const rulesReadStarted = createDeferred();
    const releaseRulesRead = createDeferred();
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let blockRulesRead = true;
    api.storage.local.get = (keys, callback) => {
      if (blockRulesRead && keys === 'rules') {
        blockRulesRead = false;
        rulesReadStarted.resolve();
        return releaseRulesRead.promise.then(() => originalGet(keys, callback));
      }
      return originalGet(keys, callback);
    };

    const enforcement = api.tabs.onUpdated.listeners[0](21, {
      url: 'https://blocked.example/'
    }, { id: 21, active: false, url: 'https://blocked.example/' });
    await rulesReadStarted.promise;
    await send({ type: 'stop_focus_session' });
    releaseRulesRead.resolve();
    await enforcement;

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.deepEqual(api.removedTabs, []);
  }, { local: { rules, activeRuleListId: 'general' } });
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
    assert.equal(api.contextMenuPresent, true);
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
