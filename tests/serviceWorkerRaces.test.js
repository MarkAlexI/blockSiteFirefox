import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
import { getLocalDateKey } from '../rules/dailyLimitManager.js';

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

function makeDailyLimitRule(id, listId, { blockURL = null, minutes = 10 } = {}) {
  const rule = makeFocusRule(id, listId, { blockURL });
  rule.assignments[0].blockingMode = 'daily_limit';
  rule.assignments[0].dailyLimit = { minutes };
  return rule;
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
