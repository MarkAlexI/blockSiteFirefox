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

async function exerciseFirefoxWorker({ supportsWindows }) {
  const previousBrowser = globalThis.browser;
  const previousChromeAlias = globalThis.chrome;
  const previousDebugController = globalThis.DebugController;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  let consoleErrorCount = 0;
  console.error = (...args) => {
    consoleErrorCount += 1;
    previousConsoleError(...args);
  };
  const createdAlarms = [];

  const runtimeOnStartup = createEvent();
  const runtimeOnInstalled = createEvent();
  const runtimeOnMessage = createEvent();
  const alarmsOnAlarm = createEvent();
  const tabsOnUpdated = createEvent();
  const tabsOnCreated = createEvent();
  const tabsOnActivated = createEvent();
  const windowsOnFocusChanged = createEvent();
  const contextMenusOnClicked = createEvent();
  const permissionsOnRemoved = createEvent();
  const permissionsOnAdded = createEvent();
  let hostAccessGranted = true;
  let activeTabForQuery = null;
  let pageVisibilityState = 'visible';
  const createdTabs = [];
  const removedTabs = [];
  const notifications = [];
  const runtimeMessages = [];
  const dnrUpdates = [];

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
      isPro: false,
      isLegacyUser: false,
      installationDate: '2026-08-01T00:00:00.000Z',
      licenseKey: 'BD-PRIVATE-123456'
    }
  });

  const telemetryRequests = [];
  globalThis.fetch = async (url, options) => {
    telemetryRequests.push({ url, options });
    return {
      ok: true,
      status: 202,
      async json() { return { ok: true }; }
    };
  };

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
      getManifest: () => ({ version: '4.9.0', manifest_version: 3 }),
      setUninstallURL() {},
      sendMessage(message, callback) {
        runtimeMessages.push(structuredClone(message));
        if (typeof callback === 'function') callback();
        return Promise.resolve({ success: true });
      },
      onStartup: runtimeOnStartup,
      onInstalled: runtimeOnInstalled,
      onMessage: runtimeOnMessage
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async update => { dnrUpdates.push(structuredClone(update)); }
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
      query: async queryInfo => {
        if (queryInfo?.active === true && queryInfo?.lastFocusedWindow === true && activeTabForQuery) {
          return [structuredClone(activeTabForQuery)];
        }
        return [];
      },
      create: async options => { createdTabs.push(options); return options; },
      remove: async ids => { removedTabs.push(...(Array.isArray(ids) ? ids : [ids])); },
      onUpdated: tabsOnUpdated,
      onCreated: tabsOnCreated,
      onActivated: tabsOnActivated
    },
    scripting: {
      executeScript: async details => {
        assert.equal(Number.isInteger(details?.target?.tabId), true);
        assert.equal(typeof details?.func, 'function');
        return [{
          frameId: 0,
          result: {
            visibilityState: pageVisibilityState,
            hidden: pageVisibilityState !== 'visible',
            hasFocus: pageVisibilityState === 'visible'
          }
        }];
      }
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
      contains: async () => hostAccessGranted,
      onRemoved: permissionsOnRemoved,
      onAdded: permissionsOnAdded
    },
    notifications: {
      create(id, details) { notifications.push({ id, details }); }
    },
    i18n: {
      getMessage: key => key,
      getUILanguage: () => 'en-US'
    }
  };
  if (supportsWindows) {
    globalThis.browser.windows = {
      WINDOW_ID_NONE: -1,
      get: async windowId => ({ id: windowId, focused: true }),
      getLastFocused: async () => ({ id: 1, focused: true }),
      getAll: async () => [{ id: 1, focused: true }],
      onFocusChanged: windowsOnFocusChanged
    };
  }
  globalThis.chrome = globalThis.browser;

  try {
    await import(`../scripts/service_worker.js?test=${Date.now()}`);

    assert.equal(runtimeOnStartup.listeners.length, 1);
    assert.equal(runtimeOnInstalled.listeners.length, 1);
    assert.equal(runtimeOnMessage.listeners.length, 1);
    assert.equal(alarmsOnAlarm.listeners.length, 1);
    assert.equal(tabsOnUpdated.listeners.length, 1);
    assert.equal(tabsOnCreated.listeners.length, 1);
    assert.equal(tabsOnActivated.listeners.length, 1);
    if (supportsWindows) {
      assert.equal(windowsOnFocusChanged.listeners.length, 1);
    } else {
      assert.equal(globalThis.browser.windows, undefined);
    }
    assert.equal(contextMenusOnClicked.listeners.length, 1);
    assert.equal(permissionsOnRemoved.listeners.length, 1);
    assert.equal(permissionsOnAdded.listeners.length, 1);
    assert.deepEqual(
      createdAlarms.map(alarm => alarm.name),
      ['check_pro_expiry', 'update_scheduled_rules']
    );

    const messageListener = runtimeOnMessage.listeners[0];
    const diagnostics = await sendWorkerMessage(messageListener, {
      type: 'diagnostics:getReport'
    });

    assert.equal(diagnostics.success, true);
    assert.equal(diagnostics.report.extension.version, '4.9.0');
    assert.equal(diagnostics.report.rules.total, 1);
    assert.equal(diagnostics.report.rules.lists, 1);
    assert.equal(diagnostics.report.rules.activeList, 'general');
    assert.equal(diagnostics.report.dnr.inSync, false);
    assert.equal(diagnostics.report.permissions.hostAccess, true);
    assert.equal(diagnostics.report.access.eventHistory, false);
    assert.deepEqual(diagnostics.report.recentEvents, []);
    assert.equal(JSON.stringify(diagnostics.report).includes('BD-PRIVATE'), false);
    assert.equal(diagnostics.report.telemetry.enabled, false);

    const initialConsent = await sendWorkerMessage(messageListener, {
      type: 'telemetry:getConsent'
    });
    assert.equal(initialConsent.success, true);
    assert.equal(initialConsent.consent.enabled, false);

    const enabledConsent = await sendWorkerMessage(messageListener, {
      type: 'telemetry:setConsent',
      enabled: true
    });
    assert.equal(enabledConsent.success, true);
    assert.equal(enabledConsent.consent.enabled, true);

    const removedGeneralRule = await sendWorkerMessage(messageListener, {
      type: 'rules:removeAssignment',
      payload: { ruleId: 1, listId: 'general' }
    });
    assert.equal(removedGeneralRule.success, true);
    assert.equal(removedGeneralRule.targetDeleted, true);
    assert.deepEqual(localStorage.data.rules, []);

    localStorage.data.rules = [{
      id: 2,
      blockURL: 'former-pro.example',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [
        { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        { listId: 'list-1', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }
      ]
    }];
    const removedFormerProAssignment = await sendWorkerMessage(messageListener, {
      type: 'rules:removeAssignment',
      payload: { ruleId: 2, listId: 'list-1' }
    });
    assert.equal(removedFormerProAssignment.success, true);
    assert.equal(removedFormerProAssignment.targetDeleted, false);
    assert.deepEqual(
      localStorage.data.rules[0].assignments.map(assignment => assignment.listId),
      ['general']
    );
    assert.equal(
      Object.values(localStorage.data.telemetryBuckets || {})[0]?.counters?.rule_deleted,
      2
    );

    const consoleErrorsBeforeExpectedRejection = consoleErrorCount;
    const rejectedRule = await sendWorkerMessage(messageListener, {
      type: 'rules:add',
      payload: {
        blockURL: 'example.com',
        redirectURL: 'not a valid redirect',
        category: 'social'
      }
    });
    assert.equal(rejectedRule.success, false);
    assert.equal(rejectedRule.error.code, 'validation_failed');
    assert.deepEqual(rejectedRule.error.validationErrors, ['redirect_invalid']);
    assert.equal(consoleErrorCount, consoleErrorsBeforeExpectedRejection);
    assert.equal(
      Object.values(localStorage.data.telemetryBuckets || {}).reduce(
        (total, bucket) => total + (Array.isArray(bucket?.errors) ? bucket.errors.length : 0),
        0
      ),
      0
    );

    const feedbackCounter = await sendWorkerMessage(messageListener, {
      type: 'telemetry:incrementCounter',
      name: 'feedback_prompt_shown'
    });
    assert.equal(feedbackCounter.success, true);
    assert.equal(feedbackCounter.recorded, true);

    const rejectedCounter = await sendWorkerMessage(messageListener, {
      type: 'telemetry:incrementCounter',
      name: 'feedback_private_value'
    });
    assert.equal(rejectedCounter.success, true);
    assert.equal(rejectedCounter.recorded, false);
    assert.equal(
      Object.values(localStorage.data.telemetryBuckets || {}).some(
        bucket => bucket?.counters?.feedback_private_value !== undefined
      ),
      false
    );

    await sendWorkerMessage(messageListener, {
      type: 'telemetry:recordError',
      payload: {
        source: 'worker',
        code: 'uncaught_error',
        operation: 'service_worker',
        errorName: 'TypeError',
        url: 'https://private.example/path',
        message: 'secret@example.com'
      }
    });
    assert.equal(JSON.stringify(localStorage.data.telemetryBuckets).includes('private.example'), false);
    assert.equal(JSON.stringify(localStorage.data.telemetryBuckets).includes('secret@example.com'), false);

    const telemetryDiagnostics = await sendWorkerMessage(messageListener, {
      type: 'diagnostics:getReport'
    });
    assert.equal(telemetryDiagnostics.report.telemetry.enabled, true);
    assert.equal(telemetryDiagnostics.report.telemetry.pendingCounterTotal, 3);
    assert.equal(telemetryDiagnostics.report.telemetry.pendingErrorFingerprints, 1);

    const flushed = await sendWorkerMessage(messageListener, {
      type: 'telemetry:flush',
      force: true
    });
    assert.equal(flushed.success, true);
    assert.equal(flushed.result.sent, true);
    assert.equal(telemetryRequests.length, 1);
    assert.equal(telemetryRequests[0].url, 'https://blockdistraction.com/api/telemetry');
    const telemetryPayload = JSON.parse(telemetryRequests[0].options.body);
    assert.equal(telemetryPayload.schemaVersion, 2);
    assert.match(telemetryPayload.batches[0].deliveryId, /^[0-9a-f-]{36}$/);
    assert.equal(telemetryPayload.batches[0].counters.rule_deleted, 2);
    assert.equal(telemetryPayload.batches[0].counters.feedback_prompt_shown, 1);
    assert.equal(telemetryPayload.batches[0].counters.feedback_private_value, undefined);
    assert.equal('installationId' in telemetryPayload.context, false);
    assert.equal(JSON.stringify(telemetryPayload).includes('private.example'), false);

    const disabledConsent = await sendWorkerMessage(messageListener, {
      type: 'telemetry:setConsent',
      enabled: false
    });
    assert.equal(disabledConsent.success, true);
    assert.deepEqual(localStorage.data.telemetryBuckets, {});

    const sampleNow = new Date();
    const localDate = `${sampleNow.getFullYear()}-${String(sampleNow.getMonth() + 1).padStart(2, '0')}-${String(sampleNow.getDate()).padStart(2, '0')}`;
    localStorage.data.rules = [{
      id: 7,
      blockURL: 'reddit.com',
      redirectURL: '',
      category: 'social',
      assignments: [{
        listId: 'general',
        blockingMode: 'daily_limit',
        schedule: null,
        dailyLimit: { minutes: 1 }
      }],
      disabledByUser: false,
      isWhitelist: false
    }];
    localStorage.data.dailyRuleUsage = {
      version: 2,
      date: localDate,
      usageSeconds: {},
      lastSample: { timestamp: sampleNow.getTime() - 60_000, assignmentKeys: ['7:general'] }
    };
    activeTabForQuery = {
      id: 70,
      windowId: 1,
      active: true,
      url: 'https://www.reddit.com/r/webdev/'
    };

    await alarmsOnAlarm.listeners[0]({ name: 'update_scheduled_rules' });
    assert.ok(localStorage.data.dailyRuleUsage.usageSeconds['7:general'] >= 59);
    const dailyDiagnostics = await sendWorkerMessage(messageListener, {
      type: 'diagnostics:getReport'
    });
    assert.equal(dailyDiagnostics.report.dailyLimits.configuredRules, 1);
    assert.equal(dailyDiagnostics.report.dailyLimits.usageEntries, 1);
    assert.equal(dailyDiagnostics.report.dailyLimits.tracker.resolution, 'matched');
    assert.equal(dailyDiagnostics.report.dailyLimits.tracker.activeRuleId, 7);
    assert.equal(dailyDiagnostics.report.dailyLimits.tracker.visibilityState, 'visible');
    assert.equal(dailyDiagnostics.report.dailyLimits.tracker.visibilitySource, 'document_visibility');
    assert.ok(dailyDiagnostics.report.dailyLimits.tracker.addedSeconds >= 59);

    localStorage.data.dailyRuleUsage.usageSeconds['7:general'] = 30;
    const usageBeforeHidden = 30;
    localStorage.data.dailyRuleUsage.lastSample = {
      timestamp: Date.now() - 60_000,
      assignmentKeys: ['7:general']
    };
    pageVisibilityState = 'hidden';
    await alarmsOnAlarm.listeners[0]({ name: 'update_scheduled_rules' });
    assert.equal(localStorage.data.dailyRuleUsage.usageSeconds['7:general'], usageBeforeHidden);
    const hiddenDiagnostics = await sendWorkerMessage(messageListener, {
      type: 'diagnostics:getReport'
    });
    assert.equal(hiddenDiagnostics.report.dailyLimits.tracker.resolution, 'page_hidden');
    assert.equal(hiddenDiagnostics.report.dailyLimits.tracker.visibilityState, 'hidden');
    pageVisibilityState = 'visible';
    activeTabForQuery = null;

    hostAccessGranted = false;
    await alarmsOnAlarm.listeners[0]({ name: 'update_scheduled_rules' });
    assert.equal(createdTabs.length, 1);
    assert.equal(localStorage.data.diagnosticState.lastPermissionCheck.hostAccess, false);
    assert.equal(localStorage.data.diagnosticState.lastPermissionCheck.reason, 'scheduled_alarm');

    createdTabs.length = 0;
    await alarmsOnAlarm.listeners[0]({ name: 'update_scheduled_rules' });
    assert.equal(createdTabs.length, 0);

    hostAccessGranted = true;
    await permissionsOnAdded.listeners[0]({ origins: ['*://*/*'] });
    assert.equal(localStorage.data.diagnosticState.lastPermissionCheck.hostAccess, true);
    assert.equal(localStorage.data.diagnosticState.lastPermissionCheck.reason, 'permission_added');

    const freeStatus = await sendWorkerMessage(messageListener, { type: 'check_pro_status' });
    assert.equal(freeStatus.isPro, false);
    const credentials = await sendWorkerMessage(messageListener, { type: 'get_pro_credentials' });
    assert.equal(credentials.credentials.licenseKey, 'BD-PRIVATE-123456');

    const upgraded = await sendWorkerMessage(messageListener, {
      type: 'update_pro_status',
      isPro: true,
      subscriptionData: {
        licenseKey: 'BD-PRO-WORKER-123',
        subscriptionEmail: 'person@example.com'
      }
    });
    assert.equal(upgraded.success, true);
    assert.equal(syncStorage.data.credentials.isPro, true);
    assert.equal(syncStorage.data.credentials.licenseKey, 'BD-PRO-WORKER-123');

    await contextMenusOnClicked.listeners[0]({
      menuItemId: 'blockDistraction',
      linkUrl: 'https://www.context.example/team'
    }, { url: 'https://source.example/' });
    assert.equal(localStorage.data.rules.some(rule => rule.blockURL === 'context.example/team'), true);

    const started = await sendWorkerMessage(messageListener, {
      type: 'start_focus_session',
      duration: 5,
      isHardcore: true,
      focusMode: 'blacklist'
    });
    assert.equal(started.success, true);
    assert.equal(localStorage.data.focusSession.focusActive, true);
    assert.equal(localStorage.data.focusSession.isHardcore, true);
    assert.equal(createdAlarms.some(alarm => alarm.name === 'end_focus_session'), true);

    const stopped = await sendWorkerMessage(messageListener, { type: 'stop_focus_session' });
    assert.equal(stopped.success, true);
    assert.deepEqual(localStorage.data.focusSession, {
      focusActive: false,
      focusEndTime: 0,
      isHardcore: false,
      focusMode: 'blacklist'
    });

    localStorage.data.rules = [{
      id: 31,
      blockURL: 'allowed.example',
      redirectURL: '',
      category: 'whitelist',
      isWhitelist: true,
      assignments: [{
        listId: 'general',
        disabledByUser: false,
        blockingMode: 'always',
        schedule: null,
        dailyLimit: null
      }]
    }];
    const whitelistFocus = await sendWorkerMessage(messageListener, {
      type: 'start_focus_session',
      duration: 2,
      focusMode: 'whitelist'
    });
    assert.equal(whitelistFocus.success, true);
    await tabsOnCreated.listeners[0]({
      id: 81,
      active: false,
      url: 'https://allowed.example/team'
    });
    assert.equal(removedTabs.includes(81), false);
    await tabsOnUpdated.listeners[0](82, { url: 'https://blocked.example/' }, {
      id: 82,
      active: false,
      url: 'https://blocked.example/'
    });
    assert.equal(removedTabs.includes(82), true);

    await alarmsOnAlarm.listeners[0]({
      name: 'end_focus_session',
      scheduledTime: localStorage.data.focusSession.focusEndTime
    });
    assert.equal(localStorage.data.focusSession.focusActive, false);
    assert.equal(localStorage.data.statistics.successfulFocusSessions, 1);
    assert.equal(notifications.at(-1).id, 'focus_session_ended');

    const closed = await sendWorkerMessage(messageListener, {
      type: 'CLOSE_MATCHING_TABS',
      url: 'blocked.example'
    });
    assert.equal(closed.success, true);
    messageListener({ type: 'close_current_tab' }, { tab: { id: 95 } }, () => {});
    assert.equal(removedTabs.includes(95), true);

    localStorage.data.ruleLists = [
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Study', disabledCategories: [] }
    ];
    localStorage.data.activeRuleListId = 'list-1';
    localStorage.data.rules.push(
      {
        id: 32,
        blockURL: 'restored-general.example',
        redirectURL: '',
        category: 'social',
        isWhitelist: false,
        assignments: [{ listId: 'general', blockingMode: 'always' }]
      },
      {
        id: 33,
        blockURL: 'preserved-study.example',
        redirectURL: '',
        category: 'social',
        isWhitelist: false,
        assignments: [{ listId: 'list-1', blockingMode: 'always' }]
      }
    );
    const proRefresh = await sendWorkerMessage(messageListener, {
      type: 'update_pro_status',
      isPro: true
    });
    assert.equal(proRefresh.success, true);
    assert.equal(localStorage.data.activeRuleListId, 'list-1');
    const updatesBeforeDowngrade = dnrUpdates.length;

    const downgraded = await sendWorkerMessage(messageListener, {
      type: 'update_pro_status',
      isPro: false
    });
    assert.equal(downgraded.success, true);
    assert.equal(syncStorage.data.credentials.licenseKey, null);
    assert.equal(localStorage.data.activeRuleListId, 'general');
    assert.deepEqual(localStorage.data.ruleLists.map(list => list.id), ['general', 'list-1']);
    assert.deepEqual(localStorage.data.rules.map(rule => rule.id), [31, 32, 33]);
    const recoveryUpdates = dnrUpdates.slice(updatesBeforeDowngrade);
    assert.equal(recoveryUpdates.some(update => update.addRules.some(rule => rule.id === 32)), true);
    assert.equal(recoveryUpdates.some(update => update.addRules.some(rule => rule.id === 33)), false);
    assert.equal(
      runtimeMessages.some(message => message.type === 'rules:changed' && message.activeRuleListId === 'general'),
      true
    );
    const missingLicense = await sendWorkerMessage(messageListener, { type: 'force_sync' });
    assert.equal(missingLicense.success, false);
    assert.equal(missingLicense.reason, 'no_key');

    const rejectedBulkClear = await sendWorkerMessage(messageListener, { type: 'delete_all_rules' });
    assert.equal(rejectedBulkClear.success, false);
    assert.equal(rejectedBulkClear.error.code, 'pro_required');
    assert.equal(localStorage.data.rules[0].blockURL, 'allowed.example');

    hostAccessGranted = false;
    await permissionsOnRemoved.listeners[0]({ origins: ['*://*/*'] });
    assert.equal(localStorage.data.diagnosticState.lastPermissionCheck.reason, 'permission_removed');
    assert.equal(localStorage.data.diagnosticState.lastPermissionCheck.hostAccess, false);
    hostAccessGranted = true;
    await permissionsOnAdded.listeners[0]({ origins: ['*://*/*'] });

    const regularInstallationDate = syncStorage.data.credentials.installationDate;
    syncStorage.data.credentials.installationDate = '2025-12-01T00:00:00.000Z';
    syncStorage.data.credentials.isLegacyUser = true;
    localStorage.data.activeRuleListId = 'list-1';
    const legacyDowngrade = await sendWorkerMessage(messageListener, {
      type: 'update_pro_status',
      isPro: false
    });
    assert.equal(legacyDowngrade.success, true);
    assert.equal(localStorage.data.activeRuleListId, 'list-1');
    syncStorage.data.credentials.installationDate = regularInstallationDate;
    syncStorage.data.credentials.isLegacyUser = false;

    const updateTabCount = createdTabs.length;
    await runtimeOnInstalled.listeners[0]({ reason: 'update' });
    assert.equal(createdTabs.slice(updateTabCount).some(tab => tab.url.includes('update/update.html')), true);
    assert.equal(localStorage.data.activeRuleListId, 'general');
    assert.deepEqual(localStorage.data.ruleLists.map(list => list.id), ['general', 'list-1']);

    const installTabCount = createdTabs.length;
    await runtimeOnInstalled.listeners[0]({ reason: 'install' });
    assert.equal(createdTabs.slice(installTabCount).some(tab => tab.url.includes('options/options.html')), true);

    await runtimeOnInstalled.listeners[0]({ reason: 'browser_update' });
    await runtimeOnInstalled.listeners[0]({ reason: 'shared_module_update' });

    delete localStorage.data.lastCheck;
    await runtimeOnStartup.listeners[0]();
    assert.equal(typeof localStorage.data.lastCheck, 'number');

    const cleared = await sendWorkerMessage(messageListener, {
      type: 'diagnostics:clearHistory'
    });
    assert.equal(cleared.success, true);
    assert.deepEqual(localStorage.data.diagnosticEvents, []);
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.chrome = previousChromeAlias;
    globalThis.DebugController = previousDebugController;
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  }
}

test('Firefox Android worker loads without windows API and serves privacy-safe diagnostics', async () => {
  await exerciseFirefoxWorker({ supportsWindows: false });
});

test('Firefox Desktop worker registers window-focus handling and serves privacy-safe diagnostics', async () => {
  await exerciseFirefoxWorker({ supportsWindows: true });
});
