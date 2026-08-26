import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
import { getLocalDateKey } from '../rules/dailyLimitManager.js';
import { LICENSE_SYNC_TIMEOUT_MS, VERIFY_API_URL } from '../utils/constants.js';
import { getProtectedRequestDomains } from '../utils/protectedDomains.js';

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

function createPendingTelemetry() {
  const date = new Date().toISOString().slice(0, 10);
  return {
    telemetryConsent: { version: 1, enabled: true, decidedAt: 1 },
    telemetryBuckets: {
      [date]: { date, counters: { rule_created: 1 }, errors: [] }
    }
  };
}

function getTelemetryCounter(api, name) {
  return Object.values(api.storage.local.data.telemetryBuckets || {})
    .reduce((total, bucket) => total + (Number(bucket.counters?.[name]) || 0), 0);
}

async function withMutedErrors(callback) {
  const previous = console.error;
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.error = previous;
  }
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

function makeDailyLimitRule(id, listId, { blockURL = null, minutes = 10 } = {}) {
  const rule = makeFocusRule(id, listId, { blockURL });
  rule.assignments[0].blockingMode = 'daily_limit';
  rule.assignments[0].dailyLimit = { minutes };
  return rule;
}

function makeScheduledRule(id, listId, {
  blockURL = null,
  days = [1],
  startTime = '22:00',
  endTime = '06:00'
} = {}) {
  const rule = makeFocusRule(id, listId, { blockURL });
  rule.assignments[0].blockingMode = 'schedule';
  rule.assignments[0].schedule = {
    version: 2,
    periods: [{ days, startTime, endTime }]
  };
  return rule;
}

async function withControlledClock(initial, callback) {
  const NativeDate = globalThis.Date;
  let timestamp = initial.getTime();

  class ControlledDate extends NativeDate {
    constructor(...args) {
      if (args.length === 0) super(timestamp);
      else super(...args);
    }

    static now() {
      return timestamp;
    }
  }

  globalThis.Date = ControlledDate;
  try {
    return await callback({
      set(value) { timestamp = value.getTime(); },
      now() { return new NativeDate(timestamp); }
    });
  } finally {
    globalThis.Date = NativeDate;
  }
}

function sendWorkerMessage(listener, message) {
  return new Promise((resolve, reject) => {
    if (listener(message, {}, resolve) !== true) {
      reject(new Error('Worker did not keep its response channel open: ' + message.type));
    }
  });
}

function countFullTabQueries(api) {
  const originalQuery = api.tabs.query.bind(api.tabs);
  let fullQueries = 0;
  api.tabs.query = (query, callback) => {
    if (Object.keys(query || {}).length === 0) fullQueries += 1;
    return originalQuery(query, callback);
  };
  return () => fullQueries;
}

async function withWorker(callback, {
  credentials = {},
  settings = {},
  local = {},
  dnrLimits = {},
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
    ...dnrLimits,
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

for (const [label, claimedStatus] of [
  ['boolean Pro', true],
  ['string Pro', 'true'],
  ['numeric Pro', 1],
  ['forged downgrade', false]
]) {
  test('direct runtime ' + label + ' messages cannot grant Pro or legacy access', async () => {
    await withWorker(async ({ api, send }) => {
      let requests = 0;
      api.setFetchHandler(async () => {
        requests += 1;
        throw new Error('rejected messages must not contact the license server');
      });

      const response = await send({
        type: 'update_pro_status',
        isPro: claimedStatus,
        subscriptionData: {
          licenseKey: 'BD-FORGED-KEY',
          subscriptionEmail: 'forged@example.com',
          isLegacyUser: true,
          installationDate: '2025-01-01T00:00:00.000Z'
        }
      });

      assert.equal(response.success, false);
      assert.equal(response.code, 'unauthorized_pro_transition');
      assert.equal(requests, 0);
      assert.equal(api.storage.sync.data.credentials.isPro, false);
      assert.equal(api.storage.sync.data.credentials.isLegacyUser, false);
      assert.equal(api.storage.sync.data.credentials.licenseKey, null);
      assert.equal(api.storage.sync.data.credentials.installationDate, '2026-08-01T00:00:00.000Z');
      assert.equal(api.contextMenuPresent, false);
      assert.equal(api.windows, undefined);

      const paidFocus = await send({
        type: 'start_focus_session',
        duration: 40,
        isHardcore: true,
        focusMode: 'whitelist'
      });
      assert.equal(paidFocus.success, false);
      assert.equal(api.storage.local.data.focusSession.focusActive, false);
    }, {
      credentials: { isPro: false, licenseKey: null, isLegacyUser: false },
      local: { activeRuleListId: 'general' },
      supportsWindows: false
    });
  });
}

test('runtime credential requests never expose license keys or subscription email', async () => {
  await withWorker(async ({ api, send }) => {
    const response = await send({ type: 'get_pro_credentials' });

    assert.deepEqual(response, {
      success: false,
      error: 'License credentials are not available through runtime messages',
      code: 'credentials_unavailable'
    });
    assert.equal(JSON.stringify(response).includes('BD-PRIVATE-KEY'), false);
    assert.equal(JSON.stringify(response).includes('private@example.com'), false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-PRIVATE-KEY');
  }, {
    credentials: { licenseKey: 'BD-PRIVATE-KEY', subscriptionEmail: 'private@example.com' },
    supportsWindows: false
  });
});

test('worker verifies and activates licenses without trusting caller or server legacy fields', async () => {
  for (const supportsWindows of [true, false]) {
    await withWorker(async ({ api, send }) => {
      const requests = [];
      api.setFetchHandler(async (url, options) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            isPro: true,
            email: 'verified@example.com',
            expiryDate: '2027-08-01',
            isLegacyUser: true,
            installationDate: '2025-01-01T00:00:00.000Z'
          })
        };
      });

      const response = await send({
        type: 'activate_pro_license',
        licenseKey: '  BD-WORKER-VERIFIED  ',
        isPro: true,
        isLegacyUser: true,
        installationDate: '2025-01-01T00:00:00.000Z',
        subscriptionData: {
          licenseKey: 'BD-FORGED-KEY',
          subscriptionEmail: 'forged@example.com',
          isLegacyUser: true,
          installationDate: '2025-01-01T00:00:00.000Z'
        }
      });

      assert.deepEqual(response, { success: true, isPro: true });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, VERIFY_API_URL);
      assert.equal(requests[0].options.method, 'POST');
      assert.equal(requests[0].options.signal instanceof AbortSignal, true);
      assert.deepEqual(requests[0].body, {
        key: 'BD-WORKER-VERIFIED',
        version: api.runtime.getManifest().version
      });
      assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-WORKER-VERIFIED');
      assert.equal(api.storage.sync.data.credentials.subscriptionEmail, 'verified@example.com');
      assert.equal(api.storage.sync.data.credentials.expiryDate, '2027-08-01');
      assert.equal(api.storage.sync.data.credentials.isLegacyUser, false);
      assert.equal(api.storage.sync.data.credentials.installationDate, '2026-08-01T00:00:00.000Z');
      assert.equal(api.contextMenuPresent, true);
      assert.equal(api.windows !== undefined, supportsWindows);

      const logout = await send({
        type: 'logout_pro',
        subscriptionData: {
          isLegacyUser: true,
          installationDate: '2025-01-01T00:00:00.000Z'
        }
      });
      assert.deepEqual(logout, { success: true, isPro: false });
      assert.equal(api.storage.sync.data.credentials.isLegacyUser, false);
      assert.equal(api.storage.sync.data.credentials.installationDate, '2026-08-01T00:00:00.000Z');
      assert.equal(api.contextMenuPresent, false);
    }, {
      credentials: { isPro: false, licenseKey: null, isLegacyUser: false },
      local: { activeRuleListId: 'general' },
      supportsWindows
    });
  }
});

test('successful manual activation replaces a stale no-key diagnostic state on a windowless worker', async () => {
  await withWorker(async ({ api, send }) => {
    const activated = await send({
      type: 'activate_pro_license',
      licenseKey: 'BD-DIAGNOSTIC-ACTIVATION'
    });

    assert.deepEqual(activated, { success: true, isPro: true });
    assert.equal(api.windows, undefined);
    assert.equal(api.storage.local.data.diagnosticState.lastLicenseCheck.success, true);
    assert.equal(api.storage.local.data.diagnosticState.lastLicenseCheck.isPro, true);
    assert.equal(api.storage.local.data.diagnosticState.lastLicenseCheck.reason, 'activated');
    assert.equal(api.storage.local.data.diagnosticState.lastLicenseCheck.error, null);
    assert.equal(api.storage.local.data.diagnosticState.lastLicenseCheck.timestamp > 1, true);

    const diagnostics = await send({ type: 'diagnostics:getReport' });
    assert.equal(diagnostics.success, true);
    assert.equal(diagnostics.report.license.lastCheck.reason, 'activated');
    assert.equal(diagnostics.report.license.lastCheck.success, true);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: {
      activeRuleListId: 'general',
      diagnosticState: {
        lastLicenseCheck: {
          timestamp: 1,
          success: false,
          isPro: false,
          reason: 'no_key',
          error: null
        }
      }
    },
    supportsWindows: false
  });
});

test('failed activation diagnostics cannot turn committed windowless Pro access into an error', async () => {
  await withWorker(async ({ api, send }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => {
      if (Object.prototype.hasOwnProperty.call(values, 'diagnosticState')) {
        return Promise.reject(new Error('diagnostic storage unavailable'));
      }
      return originalSet(values, callback);
    };

    const activated = await send({
      type: 'activate_pro_license',
      licenseKey: 'BD-DIAGNOSTIC-WRITE-FAILURE'
    });

    assert.deepEqual(activated, { success: true, isPro: true });
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-DIAGNOSTIC-WRITE-FAILURE');
    assert.equal(api.contextMenuPresent, true);
    assert.equal(api.windows, undefined);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' },
    supportsWindows: false
  });
});

for (const [label, licenseKey] of [
  ['missing', undefined],
  ['null', null],
  ['numeric', 42],
  ['object', { key: 'BD-FORGED' }],
  ['array', ['BD-FORGED']],
  ['empty', ''],
  ['blank', '   ']
]) {
  test('worker rejects a ' + label + ' activation key before contacting the server', async () => {
    await withWorker(async ({ api, send }) => {
      let requests = 0;
      api.setFetchHandler(async () => {
        requests += 1;
        throw new Error('invalid requests must never reach the server');
      });

      const response = await send({ type: 'activate_pro_license', licenseKey });

      assert.equal(response.success, false);
      assert.equal(response.code, 'invalid_license_request');
      assert.equal(requests, 0);
      assert.equal(api.storage.sync.data.credentials.isPro, false);
      assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    }, {
      credentials: { isPro: false, licenseKey: null },
      local: { activeRuleListId: 'general' },
      supportsWindows: false
    });
  });
}

for (const status of [400, 404, 408, 409, 422, 429, 500, 503]) {
  test('worker activation HTTP ' + status + ' preserves an existing valid Pro subscription', async () => {
    await withWorker(async ({ api, send }) => {
      api.setFetchHandler(async () => ({
        ok: false,
        status,
        json: async () => ({ error: 'Temporary license verification failure' })
      }));

      const response = await send({
        type: 'activate_pro_license',
        licenseKey: 'BD-CANDIDATE-KEY'
      });

      assert.equal(response.success, false);
      assert.equal(response.code, 'activation_failed');
      assert.equal(api.storage.sync.data.credentials.isPro, true);
      assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
      assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
    }, { supportsWindows: false });
  });
}

for (const status of [401, 403]) {
  test('worker activation HTTP ' + status + ' rejects only the proposed license', async () => {
    await withWorker(async ({ api, send }) => {
      api.setFetchHandler(async () => ({
        ok: false,
        status,
        json: async () => ({ error: 'Subscription rejected' })
      }));

      const response = await send({
        type: 'activate_pro_license',
        licenseKey: 'BD-REJECTED-KEY'
      });

      assert.equal(response.success, false);
      assert.equal(response.code, 'invalid_license');
      assert.equal(api.storage.sync.data.credentials.isPro, true);
      assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
    }, { supportsWindows: false });
  });
}

for (const [label, payload] of [
  ['truthy string', { isPro: 'true' }],
  ['numeric status', { isPro: 1 }],
  ['missing status', {}],
  ['null payload', null]
]) {
  test('worker activation rejects a server response with ' + label, async () => {
    await withWorker(async ({ api, send }) => {
      api.setFetchHandler(async () => ({
        ok: true,
        status: 200,
        json: async () => payload
      }));

      const response = await send({
        type: 'activate_pro_license',
        licenseKey: 'BD-AMBIGUOUS-KEY'
      });

      assert.equal(response.success, false);
      assert.equal(response.code, 'activation_failed');
      assert.equal(api.storage.sync.data.credentials.isPro, false);
      assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    }, {
      credentials: { isPro: false, licenseKey: null },
      local: { activeRuleListId: 'general' },
      supportsWindows: false
    });
  });
}

test('worker activation treats an explicit inactive subscription as an invalid key', async () => {
  await withWorker(async ({ api, send }) => {
    api.setFetchHandler(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isPro: false, error: 'Subscription expired' })
    }));

    const response = await send({
      type: 'activate_pro_license',
      licenseKey: 'BD-EXPIRED-KEY'
    });

    assert.equal(response.success, false);
    assert.equal(response.code, 'invalid_license');
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
  }, { supportsWindows: false });
});

test('invalid worker activation JSON preserves the current subscription and profile', async () => {
  await withWorker(async ({ api, send }) => {
    api.setFetchHandler(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('invalid backend response'); }
    }));

    const response = await send({
      type: 'activate_pro_license',
      licenseKey: 'BD-MALFORMED-RESPONSE'
    });

    assert.equal(response.success, false);
    assert.equal(response.code, 'activation_failed');
    assert.match(response.error, /invalid JSON/);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
    assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
  }, { supportsWindows: false });
});

test('offline worker activation preserves the current subscription and profile', async () => {
  await withWorker(async ({ api, send }) => {
    api.setFetchHandler(async () => { throw new TypeError('network unavailable'); });

    const response = await send({
      type: 'activate_pro_license',
      licenseKey: 'BD-OFFLINE-CANDIDATE'
    });

    assert.equal(response.success, false);
    assert.equal(response.code, 'activation_failed');
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
    assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
  }, { supportsWindows: false });
});

test('worker activation timeout aborts its request and remains retryable', async () => {
  await withWorker(async ({ api, send }) => {
    const requestStarted = createDeferred();
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const cleared = [];
    let timeoutCallback = null;

    globalThis.setTimeout = (callback, delay) => {
      if (delay === LICENSE_SYNC_TIMEOUT_MS) timeoutCallback = callback;
      return 71;
    };
    globalThis.clearTimeout = id => { cleared.push(id); };
    api.setFetchHandler((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
      }, { once: true });
      requestStarted.resolve();
    }));

    try {
      const pending = send({
        type: 'activate_pro_license',
        licenseKey: 'BD-STALLED-CANDIDATE'
      });
      await requestStarted.promise;
      assert.equal(typeof timeoutCallback, 'function');
      timeoutCallback();
      const response = await pending;

      assert.equal(response.success, false);
      assert.equal(response.code, 'activation_failed');
      assert.match(response.error, /timed out/);
      assert.deepEqual(cleared, [71]);
      assert.equal(api.storage.sync.data.credentials.isPro, true);
      assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
    } finally {
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
    }
  }, { supportsWindows: false });
});

test('failed credential reads prevent worker activation before any network request', async () => {
  await withWorker(async ({ api, send }) => {
    let requests = 0;
    api.storage.sync.getError = new Error('credential storage unavailable');
    api.setFetchHandler(async () => {
      requests += 1;
      throw new Error('credential failure must prevent network access');
    });

    const response = await withMutedErrors(() => send({
      type: 'activate_pro_license',
      licenseKey: 'BD-BLOCKED-BY-STORAGE'
    }));

    assert.equal(response.success, false);
    assert.equal(response.code, 'activation_failed');
    assert.equal(requests, 0);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
  }, { supportsWindows: false });
});

test('failed credential persistence cannot turn a verified activation into Pro access', async () => {
  await withWorker(async ({ api, send }) => {
    api.storage.sync.setError = new Error('credential storage is read-only');

    const response = await withMutedErrors(() => send({
      type: 'activate_pro_license',
      licenseKey: 'BD-VERIFIED-BUT-UNSAVED'
    }));

    assert.equal(response.success, false);
    assert.equal(response.code, 'activation_failed');
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('an activation response received after logout cannot restore the previous Pro session', async () => {
  await withWorker(async ({ api, send }) => {
    const requestStarted = createDeferred();
    const response = createDeferred();
    api.setFetchHandler(async () => {
      requestStarted.resolve();
      return response.promise;
    });

    const activation = send({
      type: 'activate_pro_license',
      licenseKey: 'BD-LATE-ACTIVATION'
    });
    await requestStarted.promise;

    const logout = await send({ type: 'logout_pro' });
    assert.equal(logout.success, true);

    response.resolve({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'late@example.com' })
    });
    const completed = await activation;

    assert.equal(completed.success, false);
    assert.equal(completed.code, 'activation_superseded');
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.equal(api.contextMenuPresent, false);
  }, { supportsWindows: false });
});

test('logout supersedes activation while its initial credential read is still delayed', async () => {
  await withWorker(async ({ api, send }) => {
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    const originalGet = api.storage.sync.get.bind(api.storage.sync);
    let held = false;
    let requests = 0;

    api.storage.sync.get = async (...args) => {
      if (!held && Array.isArray(args[0]) && args[0].includes('credentials')) {
        held = true;
        readStarted.resolve();
        await releaseRead.promise;
      }
      return originalGet(...args);
    };
    api.setFetchHandler(async () => {
      requests += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ isPro: true })
      };
    });

    const activation = send({
      type: 'activate_pro_license',
      licenseKey: 'BD-DELAYED-READ'
    });
    await readStarted.promise;
    const logout = await send({ type: 'logout_pro' });
    assert.equal(logout.success, true);

    releaseRead.resolve();
    const completed = await activation;

    assert.equal(completed.success, false);
    assert.equal(completed.code, 'activation_superseded');
    assert.equal(requests, 0);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    assert.equal(api.contextMenuPresent, false);
  }, { supportsWindows: false });
});

test('a newer verified activation supersedes an older response without exposing either key', async () => {
  await withWorker(async ({ api, send }) => {
    const requests = [];
    const firstStarted = createDeferred();
    const bothStarted = createDeferred();
    api.setFetchHandler(async (_url, options) => {
      const response = createDeferred();
      requests.push({ key: JSON.parse(options.body).key, response });
      if (requests.length === 1) firstStarted.resolve();
      if (requests.length === 2) bothStarted.resolve();
      return response.promise;
    });

    const first = send({ type: 'activate_pro_license', licenseKey: 'BD-FIRST-KEY' });
    await firstStarted.promise;
    const second = send({ type: 'activate_pro_license', licenseKey: 'BD-SECOND-KEY' });
    await bothStarted.promise;

    const latest = requests.find(request => request.key === 'BD-SECOND-KEY');
    latest.response.resolve({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'latest@example.com' })
    });
    const secondResult = await second;

    const older = requests.find(request => request.key === 'BD-FIRST-KEY');
    older.response.resolve({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'older@example.com' })
    });
    const firstResult = await first;

    assert.deepEqual(secondResult, { success: true, isPro: true });
    assert.equal(firstResult.success, false);
    assert.equal(firstResult.code, 'activation_superseded');
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-SECOND-KEY');
    assert.equal(api.storage.sync.data.credentials.subscriptionEmail, 'latest@example.com');
    assert.equal(JSON.stringify(secondResult).includes('BD-SECOND-KEY'), false);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('manual activation takes priority over a later no-key force sync', async () => {
  await withWorker(async ({ api, send }) => {
    const requestStarted = createDeferred();
    const candidateResponse = createDeferred();
    const requestedKeys = [];
    api.setFetchHandler(async (_url, options) => {
      requestedKeys.push(JSON.parse(options.body).key);
      requestStarted.resolve();
      return candidateResponse.promise;
    });

    const activation = send({
      type: 'activate_pro_license',
      licenseKey: 'BD-CANDIDATE-KEY'
    });
    await requestStarted.promise;

    const sync = await send({ type: 'force_sync' });
    assert.equal(sync.success, true);
    assert.equal(sync.isPro, false);
    assert.equal(sync.reason, 'activation_in_progress');
    assert.deepEqual(requestedKeys, ['BD-CANDIDATE-KEY']);

    candidateResponse.resolve({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'candidate@example.com' })
    });
    const activated = await activation;

    assert.deepEqual(activated, { success: true, isPro: true });
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-CANDIDATE-KEY');
    assert.equal(api.storage.sync.data.credentials.subscriptionEmail, 'candidate@example.com');
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('manual activation takes priority over later daily verification of an old key', async () => {
  await withWorker(async ({ api, alarm, send }) => {
    const requestStarted = createDeferred();
    const candidateResponse = createDeferred();
    const requestedKeys = [];
    api.setFetchHandler(async (_url, options) => {
      requestedKeys.push(JSON.parse(options.body).key);
      requestStarted.resolve();
      return candidateResponse.promise;
    });

    const activation = send({
      type: 'activate_pro_license',
      licenseKey: 'BD-REPLACEMENT-KEY'
    });
    await requestStarted.promise;

    await alarm({ name: 'check_pro_expiry' });
    assert.deepEqual(requestedKeys, ['BD-REPLACEMENT-KEY']);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');

    candidateResponse.resolve({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'replacement@example.com' })
    });
    const activated = await activation;

    assert.deepEqual(activated, { success: true, isPro: true });
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-REPLACEMENT-KEY');
    assert.equal(api.storage.sync.data.credentials.subscriptionEmail, 'replacement@example.com');
    assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
  }, { supportsWindows: false });
});

test('verified activation and logout preserve genuine legacy access and its active Rule List', async () => {
  await withWorker(async ({ api, send }) => {
    const activated = await send({
      type: 'activate_pro_license',
      licenseKey: 'BD-LEGACY-VERIFIED'
    });
    assert.equal(activated.success, true);
    assert.equal(api.storage.sync.data.credentials.isLegacyUser, true);

    const loggedOut = await send({
      type: 'logout_pro',
      subscriptionData: {
        isLegacyUser: false,
        installationDate: '2026-08-01T00:00:00.000Z'
      }
    });

    assert.equal(loggedOut.success, true);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.isLegacyUser, true);
    assert.equal(api.storage.sync.data.credentials.installationDate, '2025-12-01T00:00:00.000Z');
    assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
    assert.equal(api.contextMenuPresent, true);
  }, {
    credentials: {
      isPro: false,
      licenseKey: null,
      isLegacyUser: true,
      installationDate: '2025-12-01T00:00:00.000Z'
    },
    supportsWindows: false
  });
});

test('successful category toggles reach the outgoing telemetry payload exactly once', async () => {
  const privateRule = makeFocusRule(501, 'general', {
    blockURL: 'private-category.example'
  });

  for (const supportsWindows of [true, false]) {
    await withWorker(async ({ api, send }) => {
      const requests = [];
      api.setFetchHandler(async (url, options) => {
        requests.push({ url, options, payload: JSON.parse(options.body) });
        return { ok: true, status: 202, json: async () => ({ ok: true }) };
      });

      const disabled = await send({
        type: 'rules:toggleCategory',
        payload: { category: 'social' }
      });
      assert.equal(disabled.success, true);
      assert.deepEqual(api.storage.local.data.ruleLists[0].disabledCategories, ['social']);
      assert.equal(getTelemetryCounter(api, 'category_toggled'), 1);

      const enabled = await send({
        type: 'rules:toggleCategory',
        payload: { category: 'social' }
      });
      assert.equal(enabled.success, true);
      assert.deepEqual(api.storage.local.data.ruleLists[0].disabledCategories, []);
      assert.equal(getTelemetryCounter(api, 'category_toggled'), 2);

      const flushed = await send({ type: 'telemetry:flush', force: true });
      assert.equal(flushed.success, true);
      assert.equal(flushed.result.success, true);
      assert.equal(flushed.result.sent, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://blockdistraction.com/api/telemetry');
      assert.equal(requests[0].options.method, 'POST');
      assert.deepEqual(requests[0].payload.batches.map(batch => batch.counters), [
        { category_toggled: 2 }
      ]);
      assert.equal(JSON.stringify(requests[0].payload).includes('private-category.example'), false);
      assert.deepEqual(api.storage.local.data.telemetryBuckets, {});
      assert.equal(api.windows !== undefined, supportsWindows);
    }, {
      local: {
        activeRuleListId: 'general',
        rules: [privateRule],
        telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
      },
      supportsWindows
    });
  }
});

test('category toggles without effective consent never create or deliver telemetry', async () => {
  await withWorker(async ({ api, send }) => {
    api.permissions.getAll = async () => ({ data_collection: [] });
    let fetchCalls = 0;
    api.setFetchHandler(async () => {
      fetchCalls += 1;
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    });

    const toggled = await send({
      type: 'rules:toggleCategory',
      payload: { category: 'social' }
    });
    const flushed = await send({ type: 'telemetry:flush', force: true });

    assert.equal(toggled.success, true);
    assert.deepEqual(api.storage.local.data.ruleLists[0].disabledCategories, ['social']);
    assert.equal(getTelemetryCounter(api, 'category_toggled'), 0);
    assert.deepEqual(flushed.result, {
      success: true,
      sent: false,
      reason: 'disabled'
    });
    assert.equal(fetchCalls, 0);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: false, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('category telemetry follows the correct platform consent source when stored and native decisions disagree', async () => {
  for (const { permissionGranted, storedEnabled, expectedCounter } of [
    {
      permissionGranted: false,
      storedEnabled: true,
      expectedCounter: TEST_FIREFOX_ANDROID ? 0 : 1
    },
    {
      permissionGranted: true,
      storedEnabled: false,
      expectedCounter: TEST_FIREFOX_ANDROID ? 1 : 0
    },
    {
      permissionGranted: null,
      storedEnabled: true,
      expectedCounter: TEST_FIREFOX_ANDROID ? 0 : 1
    }
  ]) {
    await withWorker(async ({ api, send }) => {
      api.permissions.getAll = async () => {
        if (permissionGranted === null) {
          throw new Error('Firefox data-collection permission is unavailable');
        }
        return {
          data_collection: permissionGranted ? ['technicalAndInteraction'] : []
        };
      };
      const requests = [];
      api.setFetchHandler(async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return { ok: true, status: 202, json: async () => ({ ok: true }) };
      });

      const toggled = await send({
        type: 'rules:toggleCategory',
        payload: { category: 'social' }
      });
      assert.equal(toggled.success, true);
      assert.equal(getTelemetryCounter(api, 'category_toggled'), expectedCounter);

      const flushed = await send({ type: 'telemetry:flush', force: true });
      assert.equal(flushed.result.sent, expectedCounter === 1);
      assert.equal(requests.length, expectedCounter);
      if (expectedCounter === 1) {
        assert.equal(requests[0].batches[0].counters.category_toggled, 1);
      } else {
        assert.equal(flushed.result.reason, 'disabled');
      }
      assert.equal(api.windows, undefined);
    }, {
      local: {
        activeRuleListId: 'general',
        telemetryConsent: { version: 1, enabled: storedEnabled, decidedAt: 1 }
      },
      supportsWindows: false
    });
  }
});

test('a rejected Free category toggle cannot increment or deliver a successful-action counter', async () => {
  await withWorker(async ({ api, send }) => {
    let fetchCalls = 0;
    api.setFetchHandler(async () => {
      fetchCalls += 1;
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    });

    const rejected = await send({
      type: 'rules:toggleCategory',
      payload: { category: 'social' }
    });
    const flushed = await send({ type: 'telemetry:flush', force: true });

    assert.equal(rejected.success, false);
    assert.equal(rejected.error.code, 'pro_required');
    assert.deepEqual(api.storage.local.data.ruleLists[0].disabledCategories, []);
    assert.equal(getTelemetryCounter(api, 'category_toggled'), 0);
    assert.equal(flushed.result.sent, false);
    assert.equal(flushed.result.reason, 'empty');
    assert.equal(fetchCalls, 0);
    assert.equal(api.windows, undefined);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: {
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('failed category telemetry delivery retries its original batch without using the minute watchdog', async () => {
  await withWorker(async ({ api, alarm, send }) => {
    const requests = [];
    api.setFetchHandler(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1
        ? { ok: false, status: 503, json: async () => ({ ok: false }) }
        : { ok: true, status: 202, json: async () => ({ ok: true }) };
    });

    const toggled = await send({
      type: 'rules:toggleCategory',
      payload: { category: 'social' }
    });
    assert.equal(toggled.success, true);

    const failed = await send({ type: 'telemetry:flush', force: true });
    assert.equal(failed.result.success, false);
    assert.equal(failed.result.status, 503);
    assert.equal(getTelemetryCounter(api, 'category_toggled'), 1);
    assert.equal(api.alarmValues.has('telemetry_retry'), true);

    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(requests.length, 1);
    assert.equal(getTelemetryCounter(api, 'category_toggled'), 1);

    const retried = await send({ type: 'telemetry:flush', force: true });
    assert.equal(retried.result.success, true);
    assert.equal(retried.result.sent, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].batches[0].counters.category_toggled, 1);
    assert.equal(requests[1].batches[0].counters.category_toggled, 1);
    assert.equal(requests[0].batches[0].deliveryId, requests[1].batches[0].deliveryId);
    assert.deepEqual(api.storage.local.data.telemetryBuckets, {});
    assert.equal(api.alarmValues.has('telemetry_retry'), false);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('a category toggle during an in-flight flush remains pending for the next delivery', async () => {
  await withWorker(async ({ api, send }) => {
    const uploadStarted = createDeferred();
    const acceptUpload = createDeferred();
    const requests = [];
    api.setFetchHandler(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        uploadStarted.resolve();
        return acceptUpload.promise;
      }
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    });

    const firstToggle = await send({
      type: 'rules:toggleCategory',
      payload: { category: 'social' }
    });
    assert.equal(firstToggle.success, true);

    const firstFlush = send({ type: 'telemetry:flush', force: true });
    await uploadStarted.promise;

    const secondToggle = await send({
      type: 'rules:toggleCategory',
      payload: { category: 'social' }
    });
    assert.equal(secondToggle.success, true);
    assert.equal(getTelemetryCounter(api, 'category_toggled'), 2);

    acceptUpload.resolve({ ok: true, status: 202, json: async () => ({ ok: true }) });
    const firstResult = await firstFlush;
    assert.equal(firstResult.result.success, true);
    assert.equal(getTelemetryCounter(api, 'category_toggled'), 1);

    const secondResult = await send({ type: 'telemetry:flush', force: true });
    assert.equal(secondResult.result.success, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(payload => payload.batches[0].counters), [
      { category_toggled: 1 },
      { category_toggled: 1 }
    ]);
    assert.notEqual(requests[0].batches[0].deliveryId, requests[1].batches[0].deliveryId);
    assert.deepEqual(api.storage.local.data.telemetryBuckets, {});
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('a rejected category telemetry write cannot undo an already committed category mutation', async () => {
  const rule = makeFocusRule(502, 'general', {
    blockURL: 'committed-category.example'
  });

  await withWorker(async ({ api, alarm, send }) => {
    await alarm({ name: 'update_scheduled_rules' });
    assert.deepEqual(api.dynamicRules.map(item => item.id), [502]);

    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => Object.hasOwn(values, 'telemetryBuckets')
      ? Promise.reject(new Error('category telemetry storage unavailable'))
      : originalSet(values, callback);

    const toggled = await send({
      type: 'rules:toggleCategory',
      payload: { category: 'social' }
    });

    assert.equal(toggled.success, true);
    assert.deepEqual(api.storage.local.data.ruleLists[0].disabledCategories, ['social']);
    assert.deepEqual(api.dynamicRules, []);
    assert.equal(getTelemetryCounter(api, 'category_toggled'), 0);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [rule],
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

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

test('windowless watchdog checks stable active rules without rescanning every open tab', async () => {
  const rule = makeFocusRule(31, 'general', { blockURL: 'blocked.example' });
  await withWorker(async ({ api, alarm }) => {
    api.tabs.values.push({ id: 3, url: 'https://safe.example/' });
    const fullQueries = countFullTabQueries(api);
    let permissionChecks = 0;
    let dnrReads = 0;
    const writes = [];
    const originalPermissionCheck = api.permissions.contains;
    const originalDnrRead = api.declarativeNetRequest.getDynamicRules;
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.permissions.contains = async (...args) => {
      permissionChecks += 1;
      return originalPermissionCheck(...args);
    };
    api.declarativeNetRequest.getDynamicRules = async (...args) => {
      dnrReads += 1;
      return originalDnrRead(...args);
    };
    api.storage.local.set = (values, callback) => {
      writes.push(Object.keys(values));
      return originalSet(values, callback);
    };

    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(fullQueries(), 1);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [31]);
    writes.length = 0;
    permissionChecks = 0;
    dnrReads = 0;

    await alarm({ name: 'update_scheduled_rules' });
    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(fullQueries(), 1);
    assert.equal(permissionChecks, 2);
    assert.equal(dnrReads, 2);
    assert.deepEqual(writes, []);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [31]);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules: [rule], activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless watchdog repairs missing DNR protection and closes matching existing tabs', async () => {
  const rule = makeFocusRule(32, 'general', { blockURL: 'blocked.example' });
  await withWorker(async ({ api, alarm }) => {
    api.tabs.values.push({ id: 4, url: 'https://safe.example/' });
    const fullQueries = countFullTabQueries(api);
    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(fullQueries(), 1);

    api.dynamicRules = [];
    api.tabs.values.push({ id: 5, url: 'https://blocked.example/watch' });
    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(fullQueries(), 2);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [32]);
    assert.deepEqual(api.removedTabs, [5]);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules: [rule], activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless watchdog protects OAuth and project tabs while blocking matching real sites', async () => {
  const rules = [
    makeFocusRule(81, 'general', { blockURL: 'yout' }),
    makeFocusRule(82, 'general', { blockURL: 'goog' }),
    makeFocusRule(83, 'general', { blockURL: 'block' }),
    makeFocusRule(84, 'general', { blockURL: 'markdigital' })
  ];
  rules[0].redirectURL = 'https://example.org/focus';

  await withWorker(async ({ api, alarm }) => {
    api.tabs.values.push(
      { id: 101, url: 'https://accounts.youtube.com/accounts/SetSID' },
      { id: 102, url: 'https://m.youtube.com/watch?v=1' },
      { id: 103, url: 'https://accounts.google.com/o/oauth2/auth' },
      { id: 104, url: 'https://www.google.com/search?q=test' },
      { id: 105, url: 'https://blockdistraction.com/login.html' },
      { id: 106, url: 'https://blocking.example/' },
      { id: 107, url: 'https://markdigital.cc/' },
      { id: 108, url: 'https://markdigital.com/' }
    );

    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(api.removedTabs, [102, 104, 106, 108]);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [81, 82, 83, 84]);
    for (const browserRule of api.dynamicRules) {
      assert.deepEqual(
        browserRule.condition.excludedRequestDomains,
        [...getProtectedRequestDomains()]
      );
    }
    const customRedirect = new URL(api.dynamicRules[0].action.redirect.url);
    assert.equal(customRedirect.pathname, '/redirect.html');
    assert.equal(customRedirect.searchParams.get('to'), 'https://example.org/focus');
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules, activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless watchdog upgrades old DNR rules without closing the OAuth popup', async () => {
  const rule = makeFocusRule(84, 'general', { blockURL: 'yout' });

  await withWorker(async ({ api, alarm }) => {
    api.tabs.values.push({ id: 111, url: 'https://safe.example/' });
    const fullQueries = countFullTabQueries(api);
    await alarm({ name: 'update_scheduled_rules' });

    const stale = structuredClone(api.dynamicRules[0]);
    delete stale.condition.excludedRequestDomains;
    api.dynamicRules = [stale];
    api.tabs.values.push(
      { id: 112, url: 'https://accounts.youtube.com/accounts/SetSID' },
      { id: 113, url: 'https://youtube.com/watch?v=1' }
    );
    const initialUpdates = api.dnrUpdates.length;

    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(api.dnrUpdates[initialUpdates].removeRuleIds, [84]);
    assert.deepEqual(
      api.dnrUpdates[initialUpdates].addRules[0].condition.excludedRequestDomains,
      [...getProtectedRequestDomains()]
    );
    assert.deepEqual(api.removedTabs, [113]);
    assert.equal(fullQueries(), 2);

    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(api.dnrUpdates.length, initialUpdates + 1);
    assert.equal(fullQueries(), 2);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules: [rule], activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless startup repairs old DNR exclusions before reconciling protected tabs', async () => {
  const rule = makeFocusRule(85, 'general', { blockURL: 'yout' });

  await withWorker(async ({ api, alarm, startup }) => {
    api.tabs.values.push({ id: 121, url: 'https://safe.example/' });
    await alarm({ name: 'update_scheduled_rules' });

    const stale = structuredClone(api.dynamicRules[0]);
    delete stale.condition.excludedRequestDomains;
    api.dynamicRules = [stale];
    api.tabs.values.push(
      { id: 122, url: 'https://accounts.youtube.com/accounts/SetSID' },
      { id: 123, url: 'https://m.youtube.com/watch?v=1' }
    );

    await startup();

    assert.deepEqual(api.removedTabs, [123]);
    assert.deepEqual(
      api.dynamicRules[0].condition.excludedRequestDomains,
      [...getProtectedRequestDomains()]
    );
    assert.equal(api.windows, undefined);
  }, {
    local: {
      rules: [rule],
      activeRuleListId: 'general',
      lastCheck: Date.now()
    },
    supportsWindows: false
  });
});

test('windowless worker rejects direct OAuth targets while allowing the yout shortcut', async () => {
  await withWorker(async ({ api, send }) => {
    for (const blockURL of ['accounts.google.com', 'accounts.youtube.com']) {
      const rejected = await send({
        type: 'rules:add',
        payload: { blockURL, redirectURL: '', category: 'social' }
      });

      assert.equal(rejected.success, false);
      assert.equal(rejected.error.code, 'validation_failed');
      assert.equal(rejected.error.validationErrors.includes('blockurl_restrict'), true);
    }

    const accepted = await send({
      type: 'rules:add',
      payload: { blockURL: 'yout', redirectURL: '', category: 'social' }
    });

    assert.equal(accepted.success, true);
    assert.equal(api.dynamicRules[0].condition.urlFilter, '||yout');
    assert.equal(
      api.dynamicRules[0].condition.excludedRequestDomains.includes('accounts.youtube.com'),
      true
    );
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless watchdog enforces a newly exhausted Daily Limit instead of skipping tab cleanup', async () => {
  const rule = makeDailyLimitRule(33, 'general', {
    blockURL: 'limited.example',
    minutes: 1
  });
  await withWorker(async ({ api, alarm }) => {
    api.tabs.values.push({ id: 6, url: 'https://safe.example/' });
    const fullQueries = countFullTabQueries(api);
    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(fullQueries(), 0);
    assert.deepEqual(api.dynamicRules, []);

    api.storage.local.data.dailyRuleUsage = {
      version: 2,
      date: getLocalDateKey(),
      usageSeconds: { '33:general': 60 },
      lastSample: null
    };
    api.tabs.values.push({ id: 7, url: 'https://limited.example/watch' });
    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(fullQueries(), 1);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [33]);
    assert.deepEqual(api.removedTabs, [7]);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules: [rule], activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless watchdog closes tabs when a previously disabled category becomes active', async () => {
  const rule = makeFocusRule(34, 'general', { blockURL: 'social.example' });
  await withWorker(async ({ api, alarm }) => {
    api.tabs.values.push(
      { id: 8, url: 'https://safe.example/' },
      { id: 9, url: 'https://social.example/feed' }
    );
    const fullQueries = countFullTabQueries(api);
    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(fullQueries(), 0);
    assert.deepEqual(api.dynamicRules, []);

    api.storage.local.data.ruleLists[0].disabledCategories = [];
    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(fullQueries(), 1);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [34]);
    assert.deepEqual(api.removedTabs, [9]);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      rules: [rule],
      activeRuleListId: 'general',
      ruleLists: [{ id: 'general', name: 'General', disabledCategories: ['social'] }]
    },
    supportsWindows: false
  });
});

test('windowless watchdog enforces a newly selected Rule List before suppressing stable scans', async () => {
  const rule = makeFocusRule(37, 'list-1', { blockURL: 'study.example' });
  await withWorker(async ({ api, alarm }) => {
    api.tabs.values.push(
      { id: 16, url: 'https://safe.example/' },
      { id: 17, url: 'https://study.example/session' }
    );
    const fullQueries = countFullTabQueries(api);
    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(fullQueries(), 0);
    assert.deepEqual(api.dynamicRules, []);

    api.storage.local.data.activeRuleListId = 'list-1';
    await alarm({ name: 'update_scheduled_rules' });
    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(fullQueries(), 1);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [37]);
    assert.deepEqual(api.removedTabs, [17]);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules: [rule], activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless startup still reconciles existing blocked tabs when DNR is already current', async () => {
  const rule = makeFocusRule(35, 'general', { blockURL: 'startup.example' });
  await withWorker(async ({ api, alarm, startup }) => {
    api.tabs.values.push({ id: 10, url: 'https://safe.example/' });
    const fullQueries = countFullTabQueries(api);
    await alarm({ name: 'update_scheduled_rules' });
    const initialQueries = fullQueries();
    api.tabs.values.push({ id: 11, url: 'https://startup.example/page' });

    await startup();

    assert.equal(fullQueries() > initialQueries, true);
    assert.equal(api.removedTabs.includes(11), true);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [35]);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      rules: [rule],
      activeRuleListId: 'general',
      lastCheck: Date.now()
    },
    supportsWindows: false
  });
});

test('windowless Focus startup still closes blocked tabs when active browser rules are unchanged', async () => {
  const rule = makeFocusRule(36, 'general', { blockURL: 'focus.example' });
  await withWorker(async ({ api, alarm, send }) => {
    api.tabs.values.push({ id: 12, url: 'https://safe.example/' });
    const fullQueries = countFullTabQueries(api);
    await alarm({ name: 'update_scheduled_rules' });
    const initialQueries = fullQueries();
    api.tabs.values.push({ id: 13, url: 'https://focus.example/watch' });

    const response = await send({ type: 'start_focus_session', duration: 25 });

    assert.equal(response.success, true);
    assert.equal(fullQueries() > initialQueries, true);
    assert.equal(api.removedTabs.includes(13), true);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [36]);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules: [rule], activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless rule creation still immediately reconciles matching existing tabs', async () => {
  await withWorker(async ({ api, send }) => {
    api.tabs.values.push(
      { id: 14, url: 'https://safe.example/' },
      { id: 15, url: 'https://created.example/' }
    );
    const fullQueries = countFullTabQueries(api);

    const response = await send({
      type: 'rules:add',
      payload: {
        blockURL: 'created.example',
        redirectURL: '',
        category: 'social'
      }
    });

    assert.equal(response.success, true);
    assert.equal(fullQueries(), 1);
    assert.deepEqual(api.removedTabs, [15]);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [response.rule.id]);
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless worker imports thousands of inactive rules without exhausting active DNR capacity', async () => {
  await withWorker(async ({ api, send }) => {
    const archived = Array.from({ length: 1_500 }, (_, index) => ({
      blockURL: `archive-${index}.example`,
      redirectURL: '',
      category: 'social',
      listId: 'list-1'
    }));

    const response = await send({
      type: 'rules:replaceAll',
      payload: {
        rules: [
          ...archived,
          { blockURL: 'active.example', redirectURL: '', category: 'social' }
        ],
        ruleLists: [
          { id: 'general', name: 'General', disabledCategories: [] },
          { id: 'list-1', name: 'Archive', disabledCategories: [] }
        ],
        activeRuleListId: 'general'
      }
    });

    assert.equal(response.success, true);
    assert.equal(api.storage.local.data.rules.length, 1_501);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.deepEqual(api.dynamicRules.map(item => item.id), [1_501]);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general' },
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });
});

test('windowless worker rejects malformed imported rule entries without changing stored state', async () => {
  const original = makeFocusRule(38, 'general', { blockURL: 'keep.example' });
  await withWorker(async ({ api, alarm, send }) => {
    await alarm({ name: 'update_scheduled_rules' });
    const protectedRules = structuredClone(api.dynamicRules);

    const response = await send({
      type: 'rules:replaceAll',
      payload: {
        rules: [{ blockURL: 'replacement.example', redirectURL: '' }, null],
        settings: { mode: 'strict' }
      }
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, 'invalid_import');
    assert.match(response.error.message, /rule 2 must be an object/);
    assert.deepEqual(api.storage.local.data.rules, [original]);
    assert.equal(api.storage.sync.data.settings.mode, 'normal');
    assert.deepEqual(api.dynamicRules, protectedRules);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules: [original], activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless workers reject excess unsafe DNR rules without changing stored or browser rules', async () => {
  await withWorker(async ({ api, send }) => {
    const first = await send({
      type: 'rules:add',
      payload: { blockURL: 'first.example', redirectURL: '', category: 'social' }
    });
    const second = await send({
      type: 'rules:add',
      payload: { blockURL: 'second.example', redirectURL: '', category: 'social' }
    });

    assert.equal(first.success, true);
    assert.equal(second.success, false);
    assert.equal(second.error.code, 'dnr_rule_limit_reached');
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.blockURL), ['first.example']);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [first.rule.id]);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general' },
    dnrLimits: {
      MAX_NUMBER_OF_DYNAMIC_RULES: 10,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1
    },
    supportsWindows: false
  });
});

test('Free users can delete at browser DNR capacity and immediately add a replacement', async () => {
  await withWorker(async ({ api, send }) => {
    const first = await send({
      type: 'rules:add',
      payload: { blockURL: 'first.example', redirectURL: '', category: 'social' }
    });
    const rejected = await send({
      type: 'rules:add',
      payload: { blockURL: 'over-limit.example', redirectURL: '', category: 'social' }
    });
    const deleted = await send({
      type: 'rules:removeAssignment',
      payload: { ruleId: first.rule.id, listId: 'general' }
    });
    const replacement = await send({
      type: 'rules:add',
      payload: { blockURL: 'replacement.example', redirectURL: '', category: 'social' }
    });

    assert.equal(first.success, true);
    assert.equal(rejected.error.code, 'dnr_rule_limit_reached');
    assert.equal(deleted.success, true);
    assert.equal(replacement.success, true);
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.blockURL), ['replacement.example']);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [replacement.rule.id]);
    assert.equal(api.windows, undefined);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' },
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });
});

test('nineteen preserved custom-profile rules consume neither Free nor active DNR capacity', async () => {
  const preserved = Array.from({ length: 19 }, (_, index) =>
    makeFocusRule(index + 1, 'list-1', {
      blockURL: `study-${index + 1}.example`
    })
  );
  await withWorker(async ({ api, send }) => {
    const response = await send({
      type: 'rules:add',
      payload: { blockURL: 'free-general.example', redirectURL: '', category: 'social' }
    });

    assert.equal(response.success, true);
    assert.equal(api.storage.local.data.rules.length, 20);
    assert.equal(response.rule.id, 20);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [20]);
    assert.equal(api.windows, undefined);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general', rules: preserved },
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });
});

test('windowless diagnostics expose active redirect counts and browser DNR budgets', async () => {
  await withWorker(async ({ api, send }) => {
    const added = await send({
      type: 'rules:add',
      payload: { blockURL: 'diagnostic.example', redirectURL: '', category: 'social' }
    });
    const response = await send({ type: 'diagnostics:getReport' });

    assert.equal(added.success, true);
    assert.equal(response.success, true);
    assert.equal(response.report.dnr.expectedUnsafeCount, 1);
    assert.equal(response.report.dnr.maxDynamicRules, 8);
    assert.equal(response.report.dnr.maxUnsafeDynamicRules, 2);
    assert.equal(response.report.dnr.withinCapacity, true);
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general' },
    dnrLimits: {
      MAX_NUMBER_OF_DYNAMIC_RULES: 8,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 2
    },
    supportsWindows: false
  });
});

test('worker rejects oversized imported profiles before changing sync settings or local state', async () => {
  const original = makeFocusRule(10, 'general', { blockURL: 'keep.example' });
  await withWorker(async ({ api, send }) => {
    const response = await send({
      type: 'rules:replaceAll',
      payload: {
        rules: [
          { blockURL: 'one.example', redirectURL: '', listId: 'list-1' },
          { blockURL: 'two.example', redirectURL: '', listId: 'list-1' }
        ],
        ruleLists: [
          { id: 'general', name: 'General', disabledCategories: [] },
          { id: 'list-1', name: 'Study', disabledCategories: [] }
        ],
        activeRuleListId: 'list-1',
        settings: { mode: 'strict' }
      }
    });

    assert.equal(response.success, false);
    assert.equal(response.error.code, 'dnr_rule_limit_reached');
    assert.deepEqual(api.storage.local.data.rules, [original]);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.equal(api.storage.sync.data.settings.mode, 'normal');
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general', rules: [original] },
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });
});

test('worker keeps imported DNR rules active when optional sync settings cannot be saved', async () => {
  await withWorker(async ({ api, send }) => {
    const originalSet = api.storage.sync.set.bind(api.storage.sync);
    api.storage.sync.set = (values, callback) => Object.hasOwn(values, 'settings')
      ? Promise.reject(new Error('sync settings unavailable'))
      : originalSet(values, callback);

    const response = await send({
      type: 'rules:replaceAll',
      payload: {
        rules: [{ blockURL: 'imported.example', redirectURL: '', category: 'social' }],
        settings: { mode: 'strict' }
      }
    });

    assert.equal(response.success, true);
    assert.equal(response.settingsSyncPending, true);
    assert.equal(response.settings, null);
    assert.equal(api.storage.sync.data.settings.mode, 'normal');
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.blockURL), ['imported.example']);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [1]);
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless workers synchronize committed assignment edits after Daily Limit remap failure', async () => {
  const original = makeFocusRule(21, 'list-1', { blockURL: 'moved.example' });
  await withWorker(async ({ api, send }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let rejectedRemap = false;
    api.storage.local.get = (keys, callback) => {
      if (keys === 'dailyRuleUsage' && !rejectedRemap) {
        rejectedRemap = true;
        return Promise.reject(new Error('Daily Limit remap unavailable'));
      }
      return originalGet(keys, callback);
    };

    const response = await send({
      type: 'rules:update',
      payload: {
        ruleId: 21,
        assignmentListId: 'list-1',
        blockURL: 'moved.example',
        redirectURL: '',
        category: 'social',
        assignment: { listId: 'general', blockingMode: 'always' }
      }
    });

    assert.equal(rejectedRemap, true);
    assert.equal(response.success, true);
    assert.equal(response.dailyUsageSyncPending, true);
    assert.equal(api.storage.local.data.rules[0].assignments[0].listId, 'general');
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [21]);
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general', rules: [original] },
    supportsWindows: false
  });
});

test('windowless workers preserve 840 accumulated seconds when journal recovery reads fail', async () => {
  const original = makeDailyLimitRule(21, 'list-1', {
    blockURL: 'moved.example',
    minutes: 10
  });
  const now = new Date();
  await withWorker(async ({ api, alarm, send }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    const originalSet = api.storage.local.set.bind(api.storage.local);
    const localWrites = [];
    let rejectRecovery = true;
    api.storage.local.get = (keys, callback) => {
      if (rejectRecovery && Array.isArray(keys) &&
        keys.includes('dailyRuleUsage') && keys.includes('pendingDailyUsageRemaps')) {
        return Promise.reject(new Error('temporary Daily Limit recovery read failure'));
      }
      return originalGet(keys, callback);
    };
    api.storage.local.set = (values, callback) => {
      localWrites.push(structuredClone(values));
      return originalSet(values, callback);
    };

    const response = await send({
      type: 'rules:update',
      payload: {
        ruleId: 21,
        assignmentListId: 'list-1',
        blockURL: 'moved.example',
        redirectURL: '',
        category: 'social',
        assignment: {
          listId: 'general',
          blockingMode: 'daily_limit',
          dailyLimit: { minutes: 10 }
        }
      }
    });

    assert.equal(response.success, true);
    assert.equal(response.dailyUsageSyncPending, true);
    assert.equal(api.storage.local.data.dailyRuleUsage.usageSeconds['21:list-1'], 840);
    assert.equal(api.storage.local.data.dailyRuleUsage.usageSeconds['21:general'], undefined);
    assert.equal(api.storage.local.data.pendingDailyUsageRemaps.length, 1);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [21]);
    assert.equal(localWrites.some(write =>
      Array.isArray(write.rules) && Array.isArray(write.pendingDailyUsageRemaps)
    ), true);

    rejectRecovery = false;
    localWrites.length = 0;
    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds, { '21:general': 840 });
    assert.deepEqual(api.storage.local.data.pendingDailyUsageRemaps, []);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [21]);
    assert.equal(localWrites.filter(write =>
      Object.hasOwn(write, 'dailyRuleUsage') && Object.hasOwn(write, 'pendingDailyUsageRemaps')
    ).length, 1);

    localWrites.length = 0;
    await alarm({ name: 'update_scheduled_rules' });
    assert.deepEqual(localWrites, []);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [original],
      dailyRuleUsage: {
        version: 2,
        date: getLocalDateKey(now),
        usageSeconds: { '21:list-1': 840 },
        lastSample: null
      }
    },
    supportsWindows: false
  });
});

test('windowless workers retain the journal when Daily Limit recovery writes fail', async () => {
  const original = makeDailyLimitRule(22, 'list-1', { blockURL: 'write-failure.example' });
  await withWorker(async ({ api, alarm, send }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    let rejectRecovery = true;
    api.storage.local.set = (values, callback) => {
      if (rejectRecovery && Array.isArray(values.pendingDailyUsageRemaps) &&
        values.pendingDailyUsageRemaps.length === 0) {
        return Promise.reject(new Error('temporary Daily Limit recovery write failure'));
      }
      return originalSet(values, callback);
    };

    const response = await send({
      type: 'rules:update',
      payload: {
        ruleId: 22,
        assignmentListId: 'list-1',
        blockURL: 'write-failure.example',
        redirectURL: '',
        category: 'social',
        assignment: {
          listId: 'general',
          blockingMode: 'daily_limit',
          dailyLimit: { minutes: 10 }
        }
      }
    });

    assert.equal(response.success, true);
    assert.equal(response.dailyUsageSyncPending, true);
    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '22:list-1': 840 });
    assert.equal(api.storage.local.data.pendingDailyUsageRemaps.length, 1);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [22]);

    rejectRecovery = false;
    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '22:general': 840 });
    assert.deepEqual(api.storage.local.data.pendingDailyUsageRemaps, []);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [22]);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [original],
      dailyRuleUsage: {
        version: 2,
        date: getLocalDateKey(),
        usageSeconds: { '22:list-1': 840 },
        lastSample: null
      }
    },
    supportsWindows: false
  });
});

test('splitting a shared Daily Limit target preserves its accumulated usage and browser block', async () => {
  const original = makeDailyLimitRule(51, 'list-1', {
    blockURL: 'shared.example',
    minutes: 10
  });
  original.assignments.unshift(makeFocusRule(51, 'general').assignments[0]);
  await withWorker(async ({ api, alarm, send }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    let rejectRecovery = true;
    api.storage.local.set = (values, callback) => {
      if (rejectRecovery && Array.isArray(values.pendingDailyUsageRemaps) &&
        values.pendingDailyUsageRemaps.length === 0) {
        return Promise.reject(new Error('split usage recovery is unavailable'));
      }
      return originalSet(values, callback);
    };

    const response = await send({
      type: 'rules:update',
      payload: {
        ruleId: 51,
        assignmentListId: 'list-1',
        blockURL: 'split.example',
        redirectURL: '',
        category: 'social',
        assignment: {
          listId: 'list-1',
          blockingMode: 'daily_limit',
          dailyLimit: { minutes: 10 }
        }
      }
    });

    assert.equal(response.success, true);
    assert.equal(response.targetSplit, true);
    assert.equal(response.dailyUsageSyncPending, true);
    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '51:list-1': 840 });
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [response.rule.id]);

    rejectRecovery = false;
    await alarm({ name: 'update_scheduled_rules' });
    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { [`${response.rule.id}:list-1`]: 840 });
    assert.deepEqual(api.storage.local.data.pendingDailyUsageRemaps, []);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'list-1',
      rules: [original],
      dailyRuleUsage: {
        version: 2,
        date: getLocalDateKey(),
        usageSeconds: { '51:list-1': 840 },
        lastSample: null
      }
    },
    supportsWindows: false
  });
});

test('merging a Daily Limit target into another rule preserves the old rule usage', async () => {
  const source = makeDailyLimitRule(61, 'list-1', {
    blockURL: 'source.example',
    minutes: 10
  });
  const destination = makeFocusRule(62, 'general', {
    blockURL: 'destination.example'
  });
  await withWorker(async ({ api, alarm, send }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    let rejectRecovery = true;
    api.storage.local.set = (values, callback) => {
      if (rejectRecovery && Array.isArray(values.pendingDailyUsageRemaps) &&
        values.pendingDailyUsageRemaps.length === 0) {
        return Promise.reject(new Error('merged usage recovery is unavailable'));
      }
      return originalSet(values, callback);
    };

    const response = await send({
      type: 'rules:update',
      payload: {
        ruleId: 61,
        assignmentListId: 'list-1',
        blockURL: 'destination.example',
        redirectURL: '',
        category: 'social',
        assignment: {
          listId: 'list-1',
          blockingMode: 'daily_limit',
          dailyLimit: { minutes: 10 }
        }
      }
    });

    assert.equal(response.success, true);
    assert.equal(response.targetMerged, true);
    assert.equal(response.dailyUsageSyncPending, true);
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.id), [62]);
    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '61:list-1': 840 });
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [62]);

    rejectRecovery = false;
    await alarm({ name: 'update_scheduled_rules' });
    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '62:list-1': 840 });
    assert.deepEqual(api.storage.local.data.pendingDailyUsageRemaps, []);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'list-1',
      rules: [source, destination],
      dailyRuleUsage: {
        version: 2,
        date: getLocalDateKey(),
        usageSeconds: { '61:list-1': 840 },
        lastSample: null
      }
    },
    supportsWindows: false
  });
});

test('deleting a Rule List journals every Daily Limit remap with its atomic local commit', async () => {
  const rules = [
    makeDailyLimitRule(31, 'list-1', { blockURL: 'one.example' }),
    makeDailyLimitRule(32, 'list-1', { blockURL: 'two.example' }),
    makeFocusRule(33, 'list-1', { blockURL: 'ordinary.example' })
  ];
  await withWorker(async ({ api, alarm, send }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    let rejectRecovery = true;
    let commit = null;
    api.storage.local.set = (values, callback) => {
      if (values.rules && values.ruleLists && values.pendingDailyUsageRemaps) {
        commit = structuredClone(values);
      }
      if (rejectRecovery && Array.isArray(values.pendingDailyUsageRemaps) &&
        values.pendingDailyUsageRemaps.length === 0) {
        return Promise.reject(new Error('Daily Limit usage is temporarily unavailable'));
      }
      return originalSet(values, callback);
    };

    const response = await send({
      type: 'rules:deleteList',
      payload: { listId: 'list-1' }
    });

    assert.equal(response.success, true);
    assert.equal(response.dailyUsageSyncPending, true);
    assert.deepEqual(commit.pendingDailyUsageRemaps.map(remap => remap.oldRuleId), [31, 32]);
    assert.equal(commit.activeRuleListId, 'general');
    assert.deepEqual(api.storage.local.data.ruleLists.map(list => list.id), ['general']);
    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '31:list-1': 840, '32:list-1': 960 });
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [31, 32, 33]);

    rejectRecovery = false;
    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '31:general': 840, '32:general': 960 });
    assert.deepEqual(api.storage.local.data.pendingDailyUsageRemaps, []);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'list-1',
      rules,
      dailyRuleUsage: {
        version: 2,
        date: getLocalDateKey(),
        usageSeconds: { '31:list-1': 840, '32:list-1': 960 },
        lastSample: null
      }
    },
    supportsWindows: false
  });
});

test('windowless startup recovers pending usage before migration cleanup can delete old keys', async () => {
  const moved = makeDailyLimitRule(44, 'general', { blockURL: 'startup.example' });
  await withWorker(async ({ api, startup }) => {
    await startup();

    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '44:general': 840 });
    assert.deepEqual(api.storage.local.data.pendingDailyUsageRemaps, []);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [44]);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [moved],
      pendingDailyUsageRemaps: [{
        oldRuleId: 44, oldListId: 'list-1', newRuleId: 44, newListId: 'general'
      }],
      dailyRuleUsage: {
        version: 2,
        date: getLocalDateKey(),
        usageSeconds: { '44:list-1': 840 },
        lastSample: null
      },
      lastCheck: Date.now()
    },
    supportsWindows: false
  });
});

test('a restarted worker recovers pending usage before an unrelated Free-safe rule edit', async () => {
  const moved = makeDailyLimitRule(45, 'general', { blockURL: 'existing-limit.example' });
  await withWorker(async ({ api, send }) => {
    const response = await send({
      type: 'rules:add',
      payload: {
        blockURL: 'ordinary.example',
        redirectURL: '',
        category: 'social'
      }
    });

    assert.equal(response.success, true);
    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '45:general': 840 });
    assert.deepEqual(api.storage.local.data.pendingDailyUsageRemaps, []);
    assert.equal(api.dynamicRules.some(rule => rule.id === 45), true);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [moved],
      pendingDailyUsageRemaps: [{
        oldRuleId: 45, oldListId: 'list-1', newRuleId: 45, newListId: 'general'
      }],
      dailyRuleUsage: {
        version: 2,
        date: getLocalDateKey(),
        usageSeconds: { '45:list-1': 840 },
        lastSample: null
      }
    },
    supportsWindows: false
  });
});

test('failed startup recovery defers migration cleanup and still blocks an exhausted assignment', async () => {
  const moved = makeDailyLimitRule(46, 'general', { blockURL: 'recover-later.example' });
  await withWorker(async ({ api, alarm, startup }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let rejectRecovery = true;
    api.storage.local.get = (keys, callback) => {
      if (rejectRecovery && Array.isArray(keys) &&
        keys.includes('dailyRuleUsage') && keys.includes('pendingDailyUsageRemaps')) {
        return Promise.reject(new Error('temporary startup recovery failure'));
      }
      return originalGet(keys, callback);
    };

    await startup();

    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '46:list-1': 840 });
    assert.equal(api.storage.local.data.pendingDailyUsageRemaps.length, 1);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [46]);

    rejectRecovery = false;
    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(api.storage.local.data.dailyRuleUsage.usageSeconds,
      { '46:general': 840 });
    assert.deepEqual(api.storage.local.data.pendingDailyUsageRemaps, []);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [moved],
      pendingDailyUsageRemaps: [{
        oldRuleId: 46, oldListId: 'list-1', newRuleId: 46, newListId: 'general'
      }],
      dailyRuleUsage: {
        version: 2,
        date: getLocalDateKey(),
        usageSeconds: { '46:list-1': 840 },
        lastSample: null
      },
      lastCheck: Date.now()
    },
    supportsWindows: false
  });
});

test('failed atomic local imports never modify sync settings or existing browser protection', async () => {
  const original = makeFocusRule(10, 'general', { blockURL: 'keep.example' });
  await withWorker(async ({ api, alarm, send }) => {
    await alarm({ name: 'update_scheduled_rules' });
    const protectedIds = api.dynamicRules.map(rule => rule.id);
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) =>
      Object.hasOwn(values, 'rules') && Object.hasOwn(values, 'ruleLists')
        ? Promise.reject(new Error('atomic local import exceeded storage quota'))
        : originalSet(values, callback);

    const response = await send({
      type: 'rules:replaceAll',
      payload: {
        rules: [{ blockURL: 'replacement.example', redirectURL: '' }],
        settings: { mode: 'strict' }
      }
    });

    assert.equal(response.success, false);
    assert.match(response.error.message, /storage quota/);
    assert.deepEqual(api.storage.local.data.rules, [original]);
    assert.equal(api.storage.sync.data.settings.mode, 'normal');
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), protectedIds);
    assert.equal(api.windows, undefined);
  }, {
    local: { activeRuleListId: 'general', rules: [original] },
    supportsWindows: false
  });
});

test('repeated identical DNR quota failures do not rewrite diagnostics or analytics every minute', async () => {
  const original = makeFocusRule(1, 'general', { blockURL: 'quota.example' });
  await withWorker(async ({ api, alarm }) => {
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
    };
    const localWrites = [];
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => {
      localWrites.push(Object.keys(values));
      return originalSet(values, callback);
    };

    await alarm({ name: 'update_scheduled_rules' });
    const firstErrors = Object.values(api.storage.local.data.telemetryBuckets || {})
      .flatMap(bucket => bucket.errors || []);
    assert.equal(firstErrors.length, 1);
    assert.equal(firstErrors[0].fingerprint,
      'dnr:rule_limit_reached:update_dynamic_rules:error');
    assert.equal(api.storage.local.data.diagnosticState.lastDnrSync.errorCode,
      'dnr_rule_limit_reached');
    localWrites.length = 0;

    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(localWrites, []);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [original],
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('an identical quota failure after a windowless worker restart creates no repeated writes', async () => {
  const original = makeFocusRule(1, 'general', { blockURL: 'restart-quota.example' });
  let persistedLocalState;
  await withWorker(async ({ api, alarm }) => {
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
    };
    await alarm({ name: 'update_scheduled_rules' });
    persistedLocalState = structuredClone(api.storage.local.data);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [original],
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });

  await withWorker(async ({ api, alarm }) => {
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
    };
    const originalSet = api.storage.local.set.bind(api.storage.local);
    const writes = [];
    api.storage.local.set = (values, callback) => {
      writes.push(Object.keys(values));
      return originalSet(values, callback);
    };

    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(writes, []);
    const errors = Object.values(api.storage.local.data.telemetryBuckets || {})
      .flatMap(bucket => bucket.errors || []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].count, 1);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, { local: persistedLocalState, supportsWindows: false });
});

test('a restarted worker records a genuinely different browser DNR failure', async () => {
  const original = makeFocusRule(1, 'general', { blockURL: 'distinct-error.example' });
  let persistedLocalState;
  await withWorker(async ({ api, alarm }) => {
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
    };
    await alarm({ name: 'update_scheduled_rules' });
    persistedLocalState = structuredClone(api.storage.local.data);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [original],
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });

  await withWorker(async ({ api, alarm }) => {
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Dynamic quota exceeded after a profile change');
    };

    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(api.storage.local.data.diagnosticState.lastDnrSync.error,
      'Dynamic quota exceeded after a profile change');
    const errors = Object.values(api.storage.local.data.telemetryBuckets || {})
      .flatMap(bucket => bucket.errors || []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].count, 2);
    assert.equal(api.windows, undefined);
  }, { local: persistedLocalState, supportsWindows: false });
});

test('durable quota deduplication never suppresses a changed expected browser rule count', async () => {
  const rules = [
    makeFocusRule(71, 'general', { blockURL: 'first.example' }),
    makeFocusRule(72, 'general', { blockURL: 'second.example' })
  ];
  let persistedLocalState;
  await withWorker(async ({ api, alarm }) => {
    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(api.storage.local.data.diagnosticState.lastDnrSync.capacity.expectedCount, 2);
    persistedLocalState = structuredClone(api.storage.local.data);
  }, {
    local: {
      activeRuleListId: 'general',
      rules,
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });

  persistedLocalState.rules.push(
    makeFocusRule(73, 'general', { blockURL: 'third.example' })
  );
  await withWorker(async ({ api, alarm }) => {
    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(api.storage.local.data.diagnosticState.lastDnrSync.capacity.expectedCount, 3);
    const errors = Object.values(api.storage.local.data.telemetryBuckets || {})
      .flatMap(bucket => bucket.errors || []);
    assert.equal(errors[0].count, 2);
    assert.equal(api.windows, undefined);
  }, {
    local: persistedLocalState,
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });
});

test('a successful retry invalidates durable DNR failure deduplication across later restarts', async () => {
  const first = makeFocusRule(1, 'general', { blockURL: 'recovered.example' });
  let persistedLocalState;
  await withWorker(async ({ api, alarm }) => {
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
    };
    await alarm({ name: 'update_scheduled_rules' });
    persistedLocalState = structuredClone(api.storage.local.data);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [first],
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });

  await withWorker(async ({ api, alarm }) => {
    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(api.storage.local.data.diagnosticState.lastDnrSync.success, true);
    persistedLocalState = structuredClone(api.storage.local.data);
  }, { local: persistedLocalState, supportsWindows: false });

  await withWorker(async ({ api, alarm }) => {
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
    };
    await alarm({ name: 'update_scheduled_rules' });

    const errors = Object.values(api.storage.local.data.telemetryBuckets || {})
      .flatMap(bucket => bucket.errors || []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].count, 2);
    assert.equal(api.storage.local.data.diagnosticState.lastDnrSync.success, false);
    assert.equal(api.windows, undefined);
  }, { local: persistedLocalState, supportsWindows: false });
});

test('a recovered DNR sync clears failure deduplication before a later quota error', async () => {
  const first = makeFocusRule(1, 'general', { blockURL: 'first.example' });
  const second = makeFocusRule(2, 'general', { blockURL: 'second.example' });
  await withWorker(async ({ api, alarm }) => {
    const update = api.declarativeNetRequest.updateDynamicRules;
    let failUpdate = true;
    api.declarativeNetRequest.updateDynamicRules = async value => {
      if (failUpdate) throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
      return update(value);
    };

    await alarm({ name: 'update_scheduled_rules' });
    failUpdate = false;
    await alarm({ name: 'update_scheduled_rules' });
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [1]);

    api.storage.local.data.rules.push(second);
    failUpdate = true;
    await alarm({ name: 'update_scheduled_rules' });

    const errors = Object.values(api.storage.local.data.telemetryBuckets || {})
      .flatMap(bucket => bucket.errors || []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].count, 2);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [1]);
  }, {
    local: {
      activeRuleListId: 'general',
      rules: [first],
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('DNR quota telemetry survives diagnostic-state storage failures after a committed mutation', async () => {
  await withWorker(async ({ api, send }) => {
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
    };
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => Object.hasOwn(values, 'diagnosticState')
      ? Promise.reject(new Error('diagnostic state unavailable'))
      : originalSet(values, callback);

    const response = await send({
      type: 'rules:add',
      payload: { blockURL: 'committed.example', redirectURL: '', category: 'social' }
    });

    assert.equal(response.success, true);
    assert.equal(response.syncPending, true);
    assert.deepEqual(api.storage.local.data.rules.map(rule => rule.blockURL), ['committed.example']);
    const errors = Object.values(api.storage.local.data.telemetryBuckets || {})
      .flatMap(bucket => bucket.errors || []);
    assert.equal(errors[0].fingerprint, 'dnr:rule_limit_reached:update_dynamic_rules:error');
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
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

for (const status of [400, 404, 408, 409, 422, 429, 500, 503]) {
  test(`ambiguous license HTTP ${status} preserves Pro credentials, profile, and blocking`, async () => {
    const rule = makeFocusRule(301, 'list-1', { blockURL: 'preserved-study.example' });
    await withWorker(async ({ api, send }) => {
      api.contextMenuPresent = true;
      api.dynamicRules = [{ id: rule.id }];
      api.setFetchHandler(async () => ({
        ok: false,
        status,
        json: async () => ({ error: `License endpoint returned ${status}` })
      }));

      const response = await withMutedErrors(() => send({ type: 'force_sync' }));

      assert.equal(response.success, false);
      assert.equal(response.reason, 'temporary_failure');
      assert.equal(api.storage.sync.data.credentials.isPro, true);
      assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
      assert.equal(api.storage.sync.data.credentials.subscriptionEmail, 'member@example.com');
      assert.equal(api.storage.local.data.activeRuleListId, 'list-1');
      assert.deepEqual(api.dynamicRules.map(item => item.id), [rule.id]);
      assert.equal(api.contextMenuPresent, true);
      assert.equal(api.windows, undefined);
    }, {
      credentials: { subscriptionEmail: 'member@example.com' },
      local: { rules: [rule] },
      supportsWindows: false
    });
  });
}

for (const status of [401, 403]) {
  test(`authoritative license HTTP ${status} downgrades safely and restores General`, async () => {
    const general = makeFocusRule(311, 'general', { blockURL: 'general-kept.example' });
    const study = makeFocusRule(312, 'list-1', { blockURL: 'study-preserved.example' });
    await withWorker(async ({ api, send }) => {
      api.contextMenuPresent = true;
      api.dynamicRules = [{ id: study.id }];
      api.setFetchHandler(async () => ({
        ok: false,
        status,
        json: async () => ({ error: 'Subscription is no longer valid' })
      }));

      const response = await send({ type: 'force_sync' });

      assert.equal(response.success, true);
      assert.equal(response.reason, 'rejected');
      assert.equal(api.storage.sync.data.credentials.isPro, false);
      assert.equal(api.storage.sync.data.credentials.licenseKey, null);
      assert.equal(api.storage.sync.data.credentials.subscriptionEmail, null);
      assert.equal(api.storage.local.data.activeRuleListId, 'general');
      assert.deepEqual(api.storage.local.data.rules.map(rule => rule.id), [311, 312]);
      assert.deepEqual(api.dynamicRules.map(rule => rule.id), [311]);
      assert.equal(api.contextMenuPresent, false);
    }, {
      credentials: { subscriptionEmail: 'member@example.com' },
      local: { rules: [general, study] },
      supportsWindows: false
    });
  });
}

test('an explicit verified non-Pro license response still safely restores Free access', async () => {
  const general = makeFocusRule(321, 'general', { blockURL: 'general.example' });
  const study = makeFocusRule(322, 'list-1', { blockURL: 'study.example' });
  await withWorker(async ({ api, send }) => {
    api.setFetchHandler(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isPro: false })
    }));

    const response = await send({ type: 'force_sync' });

    assert.equal(response.success, true);
    assert.equal(response.reason, 'verified');
    assert.equal(response.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [321]);
  }, { local: { rules: [general, study] }, supportsWindows: false });
});

test('malformed license response JSON never clears an active Pro subscription', async () => {
  await withWorker(async ({ api, send }) => {
    api.contextMenuPresent = true;
    api.setFetchHandler(async () => ({
      ok: false,
      status: 403,
      json: async () => { throw new SyntaxError('invalid backend JSON'); }
    }));

    const response = await withMutedErrors(() => send({ type: 'force_sync' }));

    assert.equal(response.success, false);
    assert.equal(response.reason, 'temporary_failure');
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
    assert.equal(api.contextMenuPresent, true);
  }, { supportsWindows: false });
});

test('a malformed successful license response cannot downgrade an active subscriber', async () => {
  await withWorker(async ({ api, send }) => {
    api.setFetchHandler(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isPro: 'false' })
    }));

    const response = await withMutedErrors(() => send({ type: 'force_sync' }));

    assert.equal(response.success, false);
    assert.equal(response.reason, 'temporary_failure');
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
  }, { supportsWindows: false });
});

test('a timed-out worker license verification preserves its current Pro session', async () => {
  await withWorker(async ({ api, send }) => {
    const requestStarted = createDeferred();
    const previousSetTimeout = globalThis.setTimeout;
    let timeoutCallback = null;
    globalThis.setTimeout = (callback, delay) => {
      if (delay === LICENSE_SYNC_TIMEOUT_MS) timeoutCallback = callback;
      return 1;
    };
    api.setFetchHandler((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
      }, { once: true });
      requestStarted.resolve();
    }));

    try {
      await withMutedErrors(async () => {
        const pending = send({ type: 'force_sync' });
        await requestStarted.promise;
        assert.equal(typeof timeoutCallback, 'function');
        timeoutCallback();
        const response = await pending;

        assert.equal(response.success, false);
        assert.equal(response.reason, 'temporary_failure');
        assert.match(response.error, /timed out/);
        assert.equal(api.storage.sync.data.credentials.isPro, true);
        assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
      });
    } finally {
      globalThis.setTimeout = previousSetTimeout;
    }
  }, { supportsWindows: false });
});

test('daily license maintenance preserves a genuine legacy context menu without a key', async () => {
  await withWorker(async ({ api, alarm }) => {
    api.contextMenuPresent = true;
    let requests = 0;
    api.setFetchHandler(async () => {
      requests += 1;
      throw new Error('legacy access must not verify an absent license');
    });

    await alarm({ name: 'check_pro_expiry' });

    assert.equal(requests, 0);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.contextMenuPresent, true);
    assert.equal(api.windows, undefined);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
  }, {
    credentials: {
      isPro: false,
      licenseKey: null,
      installationDate: '2025-12-01T00:00:00.000Z'
    },
    supportsWindows: false
  });
});

test('daily license maintenance removes stale paid context menus for genuine Free users', async () => {
  await withWorker(async ({ api, alarm }) => {
    api.contextMenuPresent = true;

    await alarm({ name: 'check_pro_expiry' });

    assert.equal(api.contextMenuPresent, false);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('daily context-menu refresh cannot overtake a concurrent manual Pro logout', async () => {
  await withWorker(async ({ api, alarm, send }) => {
    api.contextMenuPresent = true;
    const refreshStarted = createDeferred();
    const resumeRefresh = createDeferred();
    const originalRemove = api.contextMenus.remove.bind(api.contextMenus);
    let removeCalls = 0;
    api.contextMenus.remove = (id, callback) => {
      if (++removeCalls === 2) {
        refreshStarted.resolve();
        void resumeRefresh.promise.then(() => originalRemove(id, callback));
        return;
      }
      originalRemove(id, callback);
    };

    const maintenance = alarm({ name: 'check_pro_expiry' });
    await refreshStarted.promise;
    let logoutCompleted = false;
    const logout = send({ type: 'logout_pro' }).then(result => {
      logoutCompleted = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logoutCompleted, false);
    resumeRefresh.resolve();
    const [, result] = await Promise.all([maintenance, logout]);

    assert.equal(result.success, true);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    assert.equal(api.contextMenuPresent, false);
    assert.equal(api.storage.local.data.activeRuleListId, 'general');
  }, { supportsWindows: false });
});

test('uninstall URL failure cannot skip daily license verification or telemetry delivery', async () => {
  await withWorker(async ({ api, alarm }) => {
    const requests = [];
    api.runtime.setUninstallURL = () => { throw new Error('uninstall URL unavailable'); };
    api.setFetchHandler(async url => {
      requests.push(url);
      return url.endsWith('/api/telemetry')
        ? { ok: true, status: 202, json: async () => ({ ok: true }) }
        : { ok: true, status: 200, json: async () => ({ isPro: true }) };
    });

    await withMutedErrors(() => alarm({ name: 'check_pro_expiry' }));

    assert.deepEqual(requests.map(url => url.split('/').at(-1)), ['verifyKey', 'telemetry']);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.contextMenuPresent, true);
    assert.deepEqual(api.storage.local.data.telemetryBuckets, {});
  }, { local: createPendingTelemetry(), supportsWindows: false });
});

test('a temporary daily license failure preserves Pro access and still delivers telemetry', async () => {
  await withWorker(async ({ api, alarm }) => {
    api.contextMenuPresent = true;
    const requests = [];
    api.setFetchHandler(async url => {
      requests.push(url);
      if (url.endsWith('/api/verifyKey')) throw new Error('license server unavailable');
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    });

    await withMutedErrors(() => alarm({ name: 'check_pro_expiry' }));

    assert.deepEqual(requests.map(url => url.split('/').at(-1)), ['verifyKey', 'telemetry']);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-OLD-KEY');
    assert.equal(api.contextMenuPresent, true);
    assert.deepEqual(api.storage.local.data.telemetryBuckets, {});
  }, { local: createPendingTelemetry(), supportsWindows: false });
});

test('a rejected license diagnostic write cannot prevent daily menu refresh and telemetry', async () => {
  await withWorker(async ({ api, alarm }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => Object.hasOwn(values, 'diagnosticState')
      ? Promise.reject(new Error('diagnostic state unavailable'))
      : originalSet(values, callback);
    const requests = [];
    api.setFetchHandler(async url => {
      requests.push(url);
      return url.endsWith('/api/telemetry')
        ? { ok: true, status: 202, json: async () => ({ ok: true }) }
        : { ok: true, status: 200, json: async () => ({ isPro: true }) };
    });

    await withMutedErrors(() => alarm({ name: 'check_pro_expiry' }));

    assert.deepEqual(requests.map(url => url.split('/').at(-1)), ['verifyKey', 'telemetry']);
    assert.equal(api.contextMenuPresent, true);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
  }, { local: createPendingTelemetry(), supportsWindows: false });
});

test('a failed daily context-menu update cannot prevent telemetry delivery', async () => {
  await withWorker(async ({ api, alarm }) => {
    api.contextMenuPresent = true;
    api.contextMenus.remove = () => { throw new Error('context menus unavailable'); };
    const requests = [];
    api.setFetchHandler(async url => {
      requests.push(url);
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    });

    await withMutedErrors(() => alarm({ name: 'check_pro_expiry' }));

    assert.deepEqual(requests.map(url => url.split('/').at(-1)), ['telemetry']);
    assert.equal(api.contextMenuPresent, true);
    assert.deepEqual(api.storage.local.data.telemetryBuckets, {});
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { ...createPendingTelemetry(), activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('failed daily entitlement reads preserve the existing legacy menu and still flush', async () => {
  await withWorker(async ({ api, alarm }) => {
    api.contextMenuPresent = true;
    const originalGet = api.storage.sync.get.bind(api.storage.sync);
    let credentialReads = 0;
    api.storage.sync.get = (keys, callback) => {
      if (Array.isArray(keys) && keys.includes('credentials') && ++credentialReads === 3) {
        return Promise.reject(new Error('entitlement snapshot unavailable'));
      }
      return originalGet(keys, callback);
    };
    const requests = [];
    api.setFetchHandler(async url => {
      requests.push(url);
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    });

    await withMutedErrors(() => alarm({ name: 'check_pro_expiry' }));

    assert.deepEqual(requests.map(url => url.split('/').at(-1)), ['telemetry']);
    assert.equal(api.contextMenuPresent, true);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
  }, {
    credentials: {
      isPro: false,
      licenseKey: null,
      installationDate: '2025-12-01T00:00:00.000Z'
    },
    local: createPendingTelemetry(),
    supportsWindows: false
  });
});

test('telemetry flush rejection cannot reject or undo daily license maintenance', async () => {
  await withWorker(async ({ api, alarm }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    api.storage.local.get = (keys, callback) => {
      if (Array.isArray(keys) && keys.includes('telemetryConsent')) {
        return Promise.reject(new Error('telemetry consent unavailable'));
      }
      return originalGet(keys, callback);
    };

    await withMutedErrors(() => assert.doesNotReject(alarm({ name: 'check_pro_expiry' })));

    assert.equal(api.uninstallUrls.length, 1);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.contextMenuPresent, false);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { activeRuleListId: 'general' },
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

    const logout = await send({ type: 'logout_pro' });
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
    api.setFetchHandler(async (_url, options) => {
      if (JSON.parse(options.body).key === 'BD-NEW-KEY') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ isPro: true, email: 'new@example.com' })
        };
      }
      requestStarted.resolve();
      return response.promise;
    });

    const verification = send({ type: 'force_sync' });
    await requestStarted.promise;

    const activation = await send({
      type: 'activate_pro_license',
      licenseKey: 'BD-NEW-KEY'
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

    const downgrade = send({ type: 'logout_pro' });
    await pauseStarted.promise;

    const activationVerified = createDeferred();
    api.setFetchHandler(async () => {
      activationVerified.resolve();
      return {
        ok: true,
        status: 200,
        json: async () => ({ isPro: true })
      };
    });
    const upgrade = send({
      type: 'activate_pro_license',
      licenseKey: 'BD-RESTORED-KEY'
    });
    await activationVerified.promise;
    await new Promise(resolve => setImmediate(resolve));
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

    const downgrading = send({ type: 'logout_pro' });
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
    const downgrading = send({ type: 'logout_pro' });
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

test('windowless minute recovery completes an expired Focus session after a missed alarm', async () => {
  const endTime = Date.now() - 30_000;
  const rules = [
    makeFocusRule(401, 'general', { blockURL: 'general-recovery.example' }),
    makeFocusRule(402, 'list-1', { blockURL: 'study-recovery.example' })
  ];
  await withWorker(async ({ api, alarm }) => {
    api.dynamicRules = [{ id: 401 }, { id: 402 }];
    api.alarmValues.set('end_focus_session', { name: 'end_focus_session', scheduledTime: endTime });

    await alarm({ name: 'update_scheduled_rules' });

    assert.deepEqual(api.storage.local.data.focusSession, {
      focusActive: false,
      focusEndTime: 0,
      isHardcore: false,
      focusMode: 'blacklist'
    });
    assert.equal(api.alarmValues.has('end_focus_session'), false);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [401]);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.equal(api.notificationsCreated.length, 1);
    assert.equal(api.notificationsCreated[0].id, 'focus_session_ended');
    const completed = Object.values(api.storage.local.data.telemetryBuckets || {})
      .reduce((total, bucket) => total + (bucket.counters?.focus_completed || 0), 0);
    assert.equal(completed, 1);
    assert.equal(api.windows, undefined);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
  }, {
    local: {
      rules,
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: true,
        focusMode: 'whitelist'
      },
      ...createPendingTelemetry()
    },
    supportsWindows: false
  });
});

test('windowless startup recovers an expired Focus session before final DNR integrity', async () => {
  const endTime = Date.now() - 5_000;
  const rules = [
    makeFocusRule(411, 'general', { blockURL: 'general-startup-recovery.example' }),
    makeFocusRule(412, 'list-1', { blockURL: 'study-startup-recovery.example' })
  ];
  await withWorker(async ({ api, startup }) => {
    api.dynamicRules = [{ id: 411 }, { id: 412 }];

    await startup();

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [411]);
    assert.equal(api.notificationsCreated.length, 1);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      rules,
      activeRuleListId: 'general',
      lastCheck: Date.now(),
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: true,
        focusMode: 'whitelist'
      }
    },
    supportsWindows: false
  });
});

test('minute recovery recreates a missing future Focus completion alarm without ending the session', async () => {
  const endTime = Date.now() + 15 * 60_000;
  await withWorker(async ({ api, alarm }) => {
    assert.equal(api.alarmValues.has('end_focus_session'), false);

    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.alarmValues.get('end_focus_session').when, endTime);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);
    assert.equal(api.notificationsCreated.length, 0);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('startup recreates a missing future Focus completion alarm', async () => {
  const endTime = Date.now() + 20 * 60_000;
  await withWorker(async ({ api, startup }) => {
    await startup();

    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.alarmValues.get('end_focus_session').when, endTime);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);
  }, {
    local: {
      activeRuleListId: 'general',
      lastCheck: Date.now(),
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('an exact future Focus alarm is not recreated by every minute watchdog', async () => {
  const endTime = Date.now() + 10 * 60_000;
  await withWorker(async ({ api, alarm }) => {
    api.alarmValues.set('end_focus_session', {
      name: 'end_focus_session',
      scheduledTime: endTime
    });
    const originalCreate = api.alarms.create.bind(api.alarms);
    let completionAlarmWrites = 0;
    api.alarms.create = (name, details) => {
      if (name === 'end_focus_session') completionAlarmWrites += 1;
      return originalCreate(name, details);
    };

    await alarm({ name: 'update_scheduled_rules' });
    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(completionAlarmWrites, 0);
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('minute recovery replaces a stale future Focus completion alarm', async () => {
  const endTime = Date.now() + 12 * 60_000;
  await withWorker(async ({ api, alarm }) => {
    api.alarmValues.set('end_focus_session', {
      name: 'end_focus_session',
      scheduledTime: endTime - 60_000
    });

    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(api.alarmValues.get('end_focus_session').when, endTime);
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('the scheduled Focus alarm completes a valid session through the shared recovery path', async () => {
  const endTime = Date.now() - 10;
  await withWorker(async ({ api, alarm }) => {
    await alarm({ name: 'end_focus_session', scheduledTime: endTime });

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.equal(api.notificationsCreated.length, 1);
  }, {
    local: {
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('simultaneous Focus alarm and minute recovery record completion exactly once', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm }) => {
    await Promise.all([
      alarm({ name: 'end_focus_session', scheduledTime: endTime }),
      alarm({ name: 'update_scheduled_rules' })
    ]);

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.equal(api.notificationsCreated.length, 1);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('a newer Focus start supersedes stale cleanup while still accounting for the expired session', async () => {
  const expiredEndTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm, send }) => {
    const recoveryReadStarted = createDeferred();
    const resumeRecoveryRead = createDeferred();
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let blocked = false;
    api.storage.local.get = (keys, callback) => {
      if (!blocked && Array.isArray(keys) && keys.includes('focusSession')) {
        blocked = true;
        const snapshot = originalGet(keys, callback);
        recoveryReadStarted.resolve();
        return resumeRecoveryRead.promise.then(() => snapshot);
      }
      return originalGet(keys, callback);
    };

    const recovery = alarm({ name: 'update_scheduled_rules' });
    await recoveryReadStarted.promise;
    const starting = send({ type: 'start_focus_session', duration: 5 });
    await new Promise(resolve => setImmediate(resolve));
    resumeRecoveryRead.resolve();
    await Promise.all([recovery, starting]);

    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.storage.local.data.focusSession.focusEndTime > Date.now(), true);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.equal(api.notificationsCreated.length, 1);
    assert.equal(api.alarmValues.get('end_focus_session').when,
      api.storage.local.data.focusSession.focusEndTime);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: expiredEndTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('a failed expired Focus state write is retried without double-counting completion', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    let rejectCompletionWrite = true;
    api.storage.local.set = (values, callback) => {
      if (rejectCompletionWrite && values.focusSession?.focusActive === false) {
        rejectCompletionWrite = false;
        return Promise.reject(new Error('focus state write unavailable'));
      }
      return originalSet(values, callback);
    };

    await withMutedErrors(() => alarm({ name: 'update_scheduled_rules' }));
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);

    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.equal(api.notificationsCreated.length, 1);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('Daily Limit sampling failure cannot prevent expired Focus cleanup', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let failed = false;
    api.storage.local.get = (keys, callback) => {
      if (!failed && keys === 'dailyRuleUsage') {
        failed = true;
        return Promise.reject(new Error('Daily Limit sample unavailable'));
      }
      return originalGet(keys, callback);
    };

    await withMutedErrors(() => alarm({ name: 'update_scheduled_rules' }));

    assert.equal(failed, true);
    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('malformed active Focus state is cleared without recording a successful session', async () => {
  await withWorker(async ({ api, alarm }) => {
    api.dynamicRules = [{ id: 999 }];
    api.alarmValues.set('end_focus_session', {
      name: 'end_focus_session',
      scheduledTime: Date.now() + 60_000
    });

    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);
    assert.equal(api.notificationsCreated.length, 0);
    assert.deepEqual(api.dynamicRules, []);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: 'invalid',
        isHardcore: true,
        focusMode: 'whitelist'
      }
    },
    supportsWindows: false
  });
});

test('starting a new Focus session first accounts for an expired previous session', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, send }) => {
    const response = await send({ type: 'start_focus_session', duration: 5 });

    assert.equal(response.success, true);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.equal(api.notificationsCreated.length, 1);
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.storage.local.data.focusSession.focusEndTime > Date.now(), true);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

for (const [label, credentials] of [
  ['Free', { isPro: false, licenseKey: null }],
  ['legacy', {
    isPro: false,
    licenseKey: null,
    isLegacyUser: true,
    installationDate: '2025-12-01T00:00:00.000Z'
  }]
]) {
  test(`${label} expired Focus recovery remains available without current Pro access`, async () => {
    const endTime = Date.now() - 1_000;
    await withWorker(async ({ api, alarm }) => {
      await alarm({ name: 'update_scheduled_rules' });

      assert.equal(api.storage.local.data.focusSession.focusActive, false);
      assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
      assert.equal(api.notificationsCreated.length, 1);
      assert.equal(api.windows, undefined);
    }, {
      credentials,
      local: {
        activeRuleListId: 'general',
        focusSession: {
          focusActive: true,
          focusEndTime: endTime,
          isHardcore: false,
          focusMode: 'blacklist'
        }
      },
      supportsWindows: false
    });
  });
}

test('notification failure cannot roll back an expired Focus completion', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm }) => {
    api.notifications.create = () => { throw new Error('notifications unavailable'); };

    await withMutedErrors(() => alarm({ name: 'update_scheduled_rules' }));

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('Focus recovery read failure cannot stop the minute DNR and permission watchdog', async () => {
  await withWorker(async ({ api, alarm }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let rejectedRecoveryRead = false;
    api.storage.local.get = (keys, callback) => {
      if (!rejectedRecoveryRead && Array.isArray(keys) && keys.includes('focusSession')) {
        rejectedRecoveryRead = true;
        return Promise.reject(new Error('focus state unavailable'));
      }
      return originalGet(keys, callback);
    };
    let permissionChecks = 0;
    let dnrReads = 0;
    const originalDnrRead = api.declarativeNetRequest.getDynamicRules;
    api.permissions.contains = async () => {
      permissionChecks += 1;
      return true;
    };
    api.declarativeNetRequest.getDynamicRules = async () => {
      dnrReads += 1;
      return originalDnrRead();
    };

    await withMutedErrors(() => alarm({ name: 'update_scheduled_rules' }));

    assert.equal(rejectedRecoveryRead, true);
    assert.equal(permissionChecks, 1);
    assert.equal(dnrReads, 1);
    assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
    assert.equal(api.windows, undefined);
  }, { supportsWindows: false });
});

test('failed Focus alarm recreation keeps the future session and retries next minute', async () => {
  const endTime = Date.now() + 15 * 60_000;
  await withWorker(async ({ api, alarm }) => {
    const originalCreate = api.alarms.create.bind(api.alarms);
    let rejectAlarm = true;
    api.alarms.create = (name, details) => {
      if (name === 'end_focus_session' && rejectAlarm) {
        rejectAlarm = false;
        return Promise.reject(new Error('alarm persistence unavailable'));
      }
      return originalCreate(name, details);
    };

    await withMutedErrors(() => alarm({ name: 'update_scheduled_rules' }));
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.alarmValues.has('end_focus_session'), false);

    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.alarmValues.get('end_focus_session').when, endTime);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('Statistics failure after Focus cleanup cannot restore or double-complete the session', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm }) => {
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let rejectStatisticsRead = true;
    api.storage.local.get = (keys, callback) => {
      if (rejectStatisticsRead && Array.isArray(keys) && keys.includes('statistics')) {
        rejectStatisticsRead = false;
        return Promise.reject(new Error('statistics unavailable'));
      }
      return originalGet(keys, callback);
    };

    await withMutedErrors(() => alarm({ name: 'update_scheduled_rules' }));
    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics, undefined);
    assert.equal(api.notificationsCreated.length, 1);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('failed Focus diagnostics and telemetry cannot undo completion or Statistics', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm }) => {
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => {
      if (Object.hasOwn(values, 'diagnosticEvents') || Object.hasOwn(values, 'telemetryBuckets')) {
        return Promise.reject(new Error('completion reporting unavailable'));
      }
      return originalSet(values, callback);
    };

    await withMutedErrors(() => alarm({ name: 'update_scheduled_rules' }));

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.equal(api.notificationsCreated.length, 1);
  }, {
    settings: { debugMode: true },
    local: {
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 },
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('minute recovery never ends a future Focus session early, while its matching alarm keeps tolerance', async () => {
  const now = Date.now();
  const endTime = now + 500;
  await withWorker(async ({ api, alarm }) => {
    const previousNow = Date.now;
    Date.now = () => now;
    try {
      await alarm({ name: 'update_scheduled_rules' });
      assert.equal(api.storage.local.data.focusSession.focusActive, true);
      assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);

      await alarm({ name: 'end_focus_session', scheduledTime: endTime });
      assert.equal(api.storage.local.data.focusSession.focusActive, false);
      assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    } finally {
      Date.now = previousNow;
    }
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('a stale alarm cannot complete a different expired Focus session, but minute recovery can', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm }) => {
    await alarm({ name: 'end_focus_session', scheduledTime: endTime - 60_000 });
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.equal(api.storage.local.data.statistics?.successfulFocusSessions || 0, 0);

    await alarm({ name: 'update_scheduled_rules' });
    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('completion alarm cleanup failure cannot roll back expired Focus state', async () => {
  const endTime = Date.now() - 1_000;
  await withWorker(async ({ api, alarm }) => {
    api.alarmValues.set('end_focus_session', {
      name: 'end_focus_session',
      scheduledTime: endTime
    });
    const originalClear = api.alarms.clear.bind(api.alarms);
    api.alarms.clear = name => name === 'end_focus_session'
      ? Promise.reject(new Error('alarm cleanup unavailable'))
      : originalClear(name);

    await withMutedErrors(() => alarm({ name: 'update_scheduled_rules' }));

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.equal(api.notificationsCreated.length, 1);
  }, {
    local: {
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('a transient completion DNR failure is repaired by the same minute watchdog', async () => {
  const endTime = Date.now() - 1_000;
  const rule = makeFocusRule(421, 'general', { blockURL: 'post-focus.example' });
  await withWorker(async ({ api, alarm }) => {
    api.dynamicRules = [{ id: 999 }];
    const originalRead = api.declarativeNetRequest.getDynamicRules;
    let rejectFirstRead = true;
    api.declarativeNetRequest.getDynamicRules = async () => {
      if (rejectFirstRead) {
        rejectFirstRead = false;
        throw new Error('DNR state temporarily unavailable');
      }
      return originalRead();
    };

    await alarm({ name: 'update_scheduled_rules' });

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.storage.local.data.statistics.successfulFocusSessions, 1);
    assert.deepEqual(api.dynamicRules.map(item => item.id), [421]);
  }, {
    local: {
      rules: [rule],
      activeRuleListId: 'general',
      focusSession: {
        focusActive: true,
        focusEndTime: endTime,
        isHardcore: false,
        focusMode: 'blacklist'
      }
    },
    supportsWindows: false
  });
});

test('Pro Focus rejects oversized global DNR activation before changing its session or alarm', async () => {
  const rules = [
    makeFocusRule(81, 'general', { blockURL: 'general.example' }),
    makeFocusRule(82, 'list-1', { blockURL: 'study.example' })
  ];
  await withWorker(async ({ api, alarm, send }) => {
    await alarm({ name: 'update_scheduled_rules' });
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [81]);
    const previousSession = structuredClone(api.storage.local.data.focusSession);
    const writes = [];
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => {
      writes.push(Object.keys(values));
      return originalSet(values, callback);
    };

    const response = await send({ type: 'start_focus_session', duration: 5 });

    assert.equal(response.success, false);
    assert.equal(response.code, 'dnr_rule_limit_reached');
    assert.match(response.error, /2\/1/);
    assert.deepEqual(api.storage.local.data.focusSession, previousSession);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [81]);
    assert.deepEqual(writes, []);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules, activeRuleListId: 'general' },
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });
});

test('legacy Focus rejects the same global DNR overflow without requiring a Pro flag', async () => {
  const rules = [
    makeFocusRule(83, 'general', { blockURL: 'general.example' }),
    makeFocusRule(84, 'list-1', { blockURL: 'study.example' })
  ];
  await withWorker(async ({ api, send }) => {
    const response = await send({ type: 'start_focus_session', duration: 45 });

    assert.equal(response.success, false);
    assert.equal(response.code, 'dnr_rule_limit_reached');
    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
    assert.equal(api.windows, undefined);
  }, {
    credentials: {
      isPro: false,
      isLegacyUser: true,
      installationDate: '2025-12-01T00:00:00.000Z'
    },
    local: { rules, activeRuleListId: 'general' },
    dnrLimits: { MAX_NUMBER_OF_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });
});

test('Free Focus starts at browser capacity because preserved paid profiles stay inactive', async () => {
  const rules = [
    makeFocusRule(85, 'general', { blockURL: 'general.example' }),
    makeFocusRule(86, 'list-1', { blockURL: 'study.example' })
  ];
  await withWorker(async ({ api, send }) => {
    const response = await send({ type: 'start_focus_session', duration: 25 });

    assert.equal(response.success, true);
    assert.equal(api.storage.local.data.focusSession.focusActive, true);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [85]);
    assert.equal(api.alarmValues.has('end_focus_session'), true);
    assert.equal(api.windows, undefined);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { rules, activeRuleListId: 'list-1' },
    dnrLimits: { MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 1 },
    supportsWindows: false
  });
});

test('Focus rolls back its session and alarm if an unreported browser quota rejects activation', async () => {
  const rules = [
    makeFocusRule(87, 'general', { blockURL: 'general.example' }),
    makeFocusRule(88, 'list-1', { blockURL: 'study.example' })
  ];
  await withWorker(async ({ api, alarm, send }) => {
    await alarm({ name: 'update_scheduled_rules' });
    const previousSession = structuredClone(api.storage.local.data.focusSession);
    const originalUpdate = api.declarativeNetRequest.updateDynamicRules;
    api.declarativeNetRequest.updateDynamicRules = async update => {
      if (update.addRules.some(rule => rule.id === 88)) {
        throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
      }
      return originalUpdate(update);
    };

    const response = await send({ type: 'start_focus_session', duration: 5 });

    assert.equal(response.success, false);
    assert.equal(response.code, 'dnr_rule_limit_reached');
    assert.deepEqual(api.storage.local.data.focusSession, previousSession);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [87]);
    const counters = Object.values(api.storage.local.data.telemetryBuckets || {})
      .flatMap(bucket => Object.keys(bucket.counters || {}));
    assert.equal(counters.includes('focus_started'), false);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      rules,
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('Focus failure responses survive rejected diagnostics and analytics writes', async () => {
  const rules = [
    makeFocusRule(94, 'general', { blockURL: 'general.example' }),
    makeFocusRule(95, 'list-1', { blockURL: 'study.example' })
  ];
  await withWorker(async ({ api, alarm, send }) => {
    await alarm({ name: 'update_scheduled_rules' });
    const originalSet = api.storage.local.set.bind(api.storage.local);
    api.storage.local.set = (values, callback) => {
      if (Object.hasOwn(values, 'diagnosticState') || Object.hasOwn(values, 'telemetryBuckets')) {
        return Promise.reject(new Error('failure reporting storage is unavailable'));
      }
      return originalSet(values, callback);
    };
    api.declarativeNetRequest.updateDynamicRules = async () => {
      throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
    };

    const response = await send({ type: 'start_focus_session', duration: 5 });

    assert.equal(response.success, false);
    assert.equal(response.code, 'dnr_rule_limit_reached');
    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [94]);
    assert.equal(api.windows, undefined);
  }, {
    local: {
      rules,
      activeRuleListId: 'general',
      telemetryConsent: { version: 1, enabled: true, decidedAt: 1 }
    },
    supportsWindows: false
  });
});

test('a failed replacement Focus restores the previously active session and exact alarm', async () => {
  const rules = [makeFocusRule(89, 'general', { blockURL: 'restore.example' })];
  await withWorker(async ({ api, send }) => {
    const started = await send({ type: 'start_focus_session', duration: 30 });
    assert.equal(started.success, true);
    const previousSession = structuredClone(api.storage.local.data.focusSession);
    const previousEndTime = api.alarmValues.get('end_focus_session').when;
    const originalGetDynamicRules = api.declarativeNetRequest.getDynamicRules;
    let rejectNextSync = true;
    api.declarativeNetRequest.getDynamicRules = async () => {
      if (rejectNextSync) {
        rejectNextSync = false;
        throw new Error('browser DNR state is temporarily unavailable');
      }
      return originalGetDynamicRules();
    };

    const response = await send({ type: 'start_focus_session', duration: 45 });

    assert.equal(response.success, false);
    assert.equal(response.code, 'dnr_sync_failed');
    assert.deepEqual(api.storage.local.data.focusSession, previousSession);
    assert.equal(api.alarmValues.get('end_focus_session').when, previousEndTime);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [89]);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules, activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('a newer stop still wins when a rejected Focus synchronization finishes late', async () => {
  const rules = [
    makeFocusRule(90, 'general', { blockURL: 'general.example' }),
    makeFocusRule(91, 'list-1', { blockURL: 'study.example' })
  ];
  await withWorker(async ({ api, alarm, send }) => {
    await alarm({ name: 'update_scheduled_rules' });
    const startedUpdate = createDeferred();
    const releaseUpdate = createDeferred();
    const originalUpdate = api.declarativeNetRequest.updateDynamicRules;
    api.declarativeNetRequest.updateDynamicRules = async update => {
      if (update.addRules.some(rule => rule.id === 91)) {
        startedUpdate.resolve();
        await releaseUpdate.promise;
        throw new Error('Exceeded MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES');
      }
      return originalUpdate(update);
    };

    const starting = send({ type: 'start_focus_session', duration: 5 });
    await startedUpdate.promise;
    const stopping = send({ type: 'stop_focus_session' });
    releaseUpdate.resolve();
    await Promise.all([starting, stopping]);

    assert.equal(api.storage.local.data.focusSession.focusActive, false);
    assert.equal(api.alarmValues.has('end_focus_session'), false);
    assert.deepEqual(api.dynamicRules.map(rule => rule.id), [90]);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules, activeRuleListId: 'general' },
    supportsWindows: false
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

    const downgraded = await send({ type: 'logout_pro' });

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

    await send({ type: 'logout_pro' });

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
    await send({ type: 'logout_pro' });

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

test('windowless worker Whitelist Focus preserves Google and YouTube OAuth popups', async () => {
  const rules = [
    makeFocusRule(143, 'general', { blockURL: 'allowed.example', isWhitelist: true })
  ];

  await withWorker(async ({ api, send }) => {
    api.tabs.values.push(
      { id: 1, url: 'https://allowed.example/' },
      { id: 2, url: 'https://accounts.google.com/o/oauth2/auth' },
      { id: 3, url: 'https://accounts.youtube.com/accounts/SetSID' },
      { id: 4, url: 'https://youtube.com/watch?v=1' },
      { id: 5, url: 'https://accounts.youtube.com.evil.example/' },
      { id: 6, url: 'https://markdigital.cc/' },
      { id: 7, url: 'https://markdigital.com/' }
    );

    const response = await send({
      type: 'start_focus_session',
      duration: 5,
      focusMode: 'whitelist'
    });

    assert.equal(response.success, true);
    assert.deepEqual(api.removedTabs, [4, 5, 7]);

    await api.tabs.onUpdated.listeners[0](9, {
      url: 'https://accounts.google.com/signin/oauth/consent'
    }, {
      id: 9,
      active: false,
      url: 'https://accounts.google.com/signin/oauth/consent'
    });

    assert.deepEqual(api.removedTabs, [4, 5, 7]);
    assert.equal(api.windows, undefined);
  }, {
    local: { rules, activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('windowless minute watchdog activates overnight rules, survives midnight, and expires at the end', async () => {
  const initial = new Date(2026, 7, 3, 21, 59);
  const scheduled = makeScheduledRule(401, 'general', { blockURL: 'night.example' });

  await withControlledClock(initial, async clock => {
    await withWorker(async ({ api, alarm }) => {
      api.tabs.values.push(
        { id: 4011, url: 'https://safe.example/' },
        { id: 4012, url: 'https://night.example/watch' }
      );
      const fullQueries = countFullTabQueries(api);

      await alarm({ name: 'update_scheduled_rules' });
      assert.deepEqual(api.dynamicRules, []);
      assert.equal(fullQueries(), 0);

      clock.set(new Date(2026, 7, 3, 22, 0));
      await alarm({ name: 'update_scheduled_rules' });
      assert.deepEqual(api.dynamicRules.map(rule => rule.id), [401]);
      assert.deepEqual(api.removedTabs, [4012]);
      assert.equal(fullQueries(), 1);

      for (const now of [
        new Date(2026, 7, 3, 23, 59),
        new Date(2026, 7, 4, 0, 0),
        new Date(2026, 7, 4, 5, 59)
      ]) {
        clock.set(now);
        await alarm({ name: 'update_scheduled_rules' });
        assert.deepEqual(api.dynamicRules.map(rule => rule.id), [401]);
        assert.equal(api.dnrUpdates.length, 1);
        assert.equal(fullQueries(), 1);
      }

      clock.set(new Date(2026, 7, 4, 6, 0));
      await alarm({ name: 'update_scheduled_rules' });
      assert.deepEqual(api.dynamicRules, []);
      assert.equal(api.dnrUpdates.length, 2);
      assert.deepEqual(api.dnrUpdates[1], { removeRuleIds: [401], addRules: [] });
      assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
      assert.equal(api.windows, undefined);
    }, {
      local: { rules: [scheduled], activeRuleListId: 'general' },
      supportsWindows: false
    });
  });
});

test('windowless workers associate early Saturday and Monday with the previous selected weekday', async () => {
  for (const { id, days, initial, expires } of [
    {
      id: 411,
      days: [5],
      initial: new Date(2026, 7, 8, 2, 30),
      expires: new Date(2026, 7, 8, 6, 0)
    },
    {
      id: 412,
      days: [0],
      initial: new Date(2026, 7, 10, 2, 30),
      expires: new Date(2026, 7, 10, 6, 0)
    }
  ]) {
    const scheduled = makeScheduledRule(id, 'general', { days });
    await withControlledClock(initial, async clock => {
      await withWorker(async ({ api, alarm }) => {
        await alarm({ name: 'update_scheduled_rules' });
        assert.deepEqual(api.dynamicRules.map(rule => rule.id), [id]);

        clock.set(expires);
        await alarm({ name: 'update_scheduled_rules' });
        assert.deepEqual(api.dynamicRules, []);
        assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
        assert.equal(api.windows, undefined);
      }, {
        local: { rules: [scheduled], activeRuleListId: 'general' },
        supportsWindows: false
      });
    });
  }
});

test('windowless startup recovers a missed overnight activation and closes existing matching tabs', async () => {
  const initial = new Date(2026, 7, 4, 3, 10);
  const scheduled = makeScheduledRule(421, 'general', { blockURL: 'late-night.example' });

  await withControlledClock(initial, async clock => {
    await withWorker(async ({ api, startup }) => {
      api.tabs.values.push(
        { id: 4211, url: 'https://safe.example/' },
        { id: 4212, url: 'https://late-night.example/video' }
      );

      await startup();

      assert.deepEqual(api.dynamicRules.map(rule => rule.id), [421]);
      assert.equal(api.removedTabs.includes(4212), true);
      assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
      assert.equal(api.windows, undefined);
    }, {
      local: {
        rules: [scheduled],
        activeRuleListId: 'general',
        lastCheck: clock.now().getTime()
      },
      supportsWindows: false
    });
  });
});

test('windowless watchdog recovers an overnight end missed while Firefox Android was sleeping', async () => {
  const initial = new Date(2026, 7, 4, 5, 55);
  const scheduled = makeScheduledRule(431, 'general');

  await withControlledClock(initial, async clock => {
    await withWorker(async ({ api, alarm }) => {
      await alarm({ name: 'update_scheduled_rules' });
      assert.deepEqual(api.dynamicRules.map(rule => rule.id), [431]);

      clock.set(new Date(2026, 7, 4, 11, 40));
      await alarm({ name: 'update_scheduled_rules' });

      assert.deepEqual(api.dynamicRules, []);
      assert.deepEqual(api.dnrUpdates[1], { removeRuleIds: [431], addRules: [] });
      assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
      assert.equal(api.windows, undefined);
    }, {
      local: { rules: [scheduled], activeRuleListId: 'general' },
      supportsWindows: false
    });
  });
});

test('windowless overnight blocking continues to follow only the selected Rule List profile', async () => {
  const initial = new Date(2026, 7, 4, 2, 0);
  const rules = [
    makeScheduledRule(441, 'general', { days: [3], blockURL: 'general-night.example' }),
    makeScheduledRule(442, 'list-1', { days: [1], blockURL: 'study-night.example' })
  ];

  await withControlledClock(initial, async () => {
    await withWorker(async ({ api, alarm }) => {
      await alarm({ name: 'update_scheduled_rules' });
      assert.deepEqual(api.dynamicRules.map(rule => rule.id), [442]);

      api.storage.local.data.activeRuleListId = 'general';
      await alarm({ name: 'update_scheduled_rules' });
      assert.deepEqual(api.dynamicRules, []);
      assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
      assert.equal(api.windows, undefined);
    }, {
      local: { rules, activeRuleListId: 'list-1' },
      supportsWindows: false
    });
  });
});

test('Free worker intents cannot create or introduce paid overnight schedules', async () => {
  const original = makeFocusRule(451, 'general', { blockURL: 'basic.example' });
  const overnight = { days: [1], startTime: '22:00', endTime: '06:00' };

  await withWorker(async ({ api, send }) => {
    const added = await send({
      type: 'rules:add',
      payload: {
        blockURL: 'unauthorized.example',
        assignment: { listId: 'general', blockingMode: 'schedule', schedule: overnight }
      }
    });
    const updated = await send({
      type: 'rules:update',
      payload: {
        ruleId: 451,
        assignmentListId: 'general',
        assignment: { listId: 'general', blockingMode: 'schedule', schedule: overnight }
      }
    });

    assert.equal(added.success, false);
    assert.equal(added.error.code, 'pro_required');
    assert.equal(updated.success, false);
    assert.equal(updated.error.code, 'pro_required');
    assert.deepEqual(api.storage.local.data.rules, [original]);
    assert.equal(api.windows, undefined);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { rules: [original], activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('former Pro windowless workers can edit, toggle, clean, and delete inherited schedules', async () => {
  const initial = new Date(2026, 7, 4, 2, 0);
  const scheduled = makeScheduledRule(461, 'general', { blockURL: 'inherited.example' });

  await withControlledClock(initial, async () => {
    await withWorker(async ({ api, alarm, send }) => {
      await alarm({ name: 'update_scheduled_rules' });
      assert.deepEqual(api.dynamicRules.map(rule => rule.id), [461]);

      const edited = await send({
        type: 'rules:update',
        payload: {
          ruleId: 461,
          assignmentListId: 'general',
          blockURL: 'renamed-inherited.example',
          assignment: {
            listId: 'general',
            blockingMode: 'schedule',
            schedule: { days: [1], startTime: '22:00', endTime: '06:00' }
          }
        }
      });
      assert.equal(edited.success, true);
      assert.equal(api.storage.local.data.rules[0].blockURL, 'renamed-inherited.example');

      const changed = await send({
        type: 'rules:update',
        payload: {
          ruleId: 461,
          assignmentListId: 'general',
          assignment: {
            listId: 'general',
            blockingMode: 'schedule',
            schedule: { days: [1], startTime: '21:00', endTime: '06:00' }
          }
        }
      });
      assert.equal(changed.success, false);
      assert.equal(changed.error.code, 'pro_required');
      assert.deepEqual(api.dynamicRules.map(rule => rule.id), [461]);

      const toggled = await send({
        type: 'rules:toggle',
        payload: { ruleId: 461, listId: 'general' }
      });
      assert.equal(toggled.success, true);
      assert.deepEqual(api.dynamicRules, []);

      const cleaned = await send({
        type: 'rules:update',
        payload: {
          ruleId: 461,
          assignmentListId: 'general',
          assignment: { listId: 'general', blockingMode: 'always', schedule: null }
        }
      });
      assert.equal(cleaned.success, true);
      assert.equal(api.storage.local.data.rules[0].assignments[0].blockingMode, 'always');

      const removed = await send({
        type: 'rules:removeAssignment',
        payload: { ruleId: 461, listId: 'general' }
      });
      assert.equal(removed.success, true);
      assert.equal(removed.targetDeleted, true);
      assert.deepEqual(api.storage.local.data.rules, []);
      assert.deepEqual(api.dynamicRules, []);
      assert.equal(api.alarmValues.get('update_scheduled_rules').periodInMinutes, 1);
      assert.equal(api.windows, undefined);
    }, {
      credentials: { isPro: false, licenseKey: null },
      local: { rules: [scheduled], activeRuleListId: 'general' },
      supportsWindows: false
    });
  });
});

test('Free worker users can delete an inherited schedule at the exact ten-rule limit and add a basic rule', async () => {
  const rules = [
    makeScheduledRule(471, 'general', { blockURL: 'replace-night.example' }),
    ...Array.from({ length: 9 }, (_, index) =>
      makeFocusRule(472 + index, 'general', { blockURL: `free-${index}.example` })
    )
  ];

  await withWorker(async ({ api, send }) => {
    const removed = await send({
      type: 'rules:removeAssignment',
      payload: { ruleId: 471, listId: 'general' }
    });
    const replacement = await send({
      type: 'rules:add',
      payload: { blockURL: 'replacement.example', redirectURL: '', category: 'social' }
    });

    assert.equal(removed.success, true);
    assert.equal(replacement.success, true);
    assert.equal(api.storage.local.data.rules.length, 10);
    assert.equal(api.storage.local.data.rules.some(rule => rule.blockURL === 'replace-night.example'), false);
    assert.equal(api.storage.local.data.rules.some(rule => rule.blockURL === 'replacement.example'), true);
    assert.equal(api.dynamicRules.length, 10);
    assert.equal(api.windows, undefined);
  }, {
    credentials: { isPro: false, licenseKey: null },
    local: { rules, activeRuleListId: 'general' },
    supportsWindows: false
  });
});

test('Pro and genuine legacy worker intents can create active overnight schedules', async () => {
  const initial = new Date(2026, 7, 4, 1, 30);

  for (const credentials of [
    { isPro: true },
    {
      isPro: false,
      isLegacyUser: true,
      licenseKey: null,
      installationDate: '2025-12-01T00:00:00.000Z'
    }
  ]) {
    await withControlledClock(initial, async () => {
      await withWorker(async ({ api, send }) => {
        const result = await send({
          type: 'rules:add',
          payload: {
            blockURL: 'authorized-night.example',
            assignment: {
              listId: 'general',
              blockingMode: 'schedule',
              schedule: { days: [1], startTime: '22:00', endTime: '06:00' }
            }
          }
        });

        assert.equal(result.success, true);
        assert.equal(api.storage.local.data.rules[0].assignments[0].blockingMode, 'schedule');
        assert.deepEqual(api.dynamicRules.map(rule => rule.id), [result.rule.id]);
        assert.equal(api.windows, undefined);
      }, {
        credentials,
        local: { activeRuleListId: 'general' },
        supportsWindows: false
      });
    });
  }
});
