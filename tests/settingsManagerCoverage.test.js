import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const defaultSettings = {
  mode: 'normal',
  confirmBeforeDelete: false,
  showNotifications: true,
  enablePassword: false,
  passwordHash: null,
  debugMode: false,
  focusSessionSound: true
};

function createSettingsDocument() {
  const document = new FakeDocument();
  document.addElement('focus-session-banner').classList.add('hidden');
  document.addElement('focus-banner-timer');
  document.addElement('statusMessage');
  document.addElement('totalRules');

  for (const id of [
    'confirmBeforeDelete', 'showNotifications', 'enablePassword',
    'enableDebug', 'focusSessionSound'
  ]) {
    const checkbox = document.addElement(id, 'input');
    checkbox.type = 'checkbox';
  }

  for (const value of ['normal', 'strict']) {
    const radio = document.addElement(`mode-${value}`, 'input');
    radio.type = 'radio';
    radio.name = 'securityMode';
    radio.value = value;
  }

  for (const id of ['exportRules', 'importRules', 'clearAllRules', 'resetSettings', 'clearStatistics']) {
    document.addElement(id, 'button');
  }
  document.addElement('importFileInput', 'input');

  for (const id of [
    'totalBlocked', 'blockedToday', 'totalRedirects', 'redirectsToday',
    'successfulFocusSessions', 'statsBlockedRangeTotal', 'statsRedirectedRangeTotal',
    'statsFocusRangeTotal', 'statsActivityChart', 'statsFocusChart'
  ]) {
    document.addElement(id);
  }

  for (const days of [7, 30, 14]) {
    const button = document.addElement(`range-${days}`, 'button');
    button.setAttribute('data-stat-range', String(days));
  }

  const collapsible = document.addElement('collapsible');
  collapsible.classList.add('collapsible-section');
  document.addElement('search-filter-container');
  document.addElement('add-rule', 'button');
  document.addElement('add-whitelist-rule', 'button');
  document.addElement('table-wrapper').classList.add('table-wrapper');

  return document;
}

async function withSettingsManager(options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  const document = createSettingsDocument();
  const api = createExtensionApi({
    sync: options.sync || {},
    local: options.local || {},
    version: '5.1.7'
  });
  const timeouts = [];
  const intervals = new Map();
  const previous = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    confirm: globalThis.confirm
  };
  let confirmResult = true;
  let reloadCount = 0;

  globalThis.setTimeout = (handler, delay) => {
    timeouts.push({ handler, delay });
    return timeouts.length;
  };
  globalThis.clearTimeout = () => {};
  globalThis.setInterval = (handler, delay) => {
    const id = intervals.size + 1;
    intervals.set(id, { handler, delay });
    return id;
  };
  globalThis.clearInterval = id => { intervals.delete(id); };
  globalThis.confirm = () => confirmResult;

  try {
    await withExtensionEnvironment(api, async () => {
      const { SettingsManager } = await import('../options/settings.js');
      const manager = Object.create(SettingsManager.prototype);
      manager.defaultSettings = structuredClone(defaultSettings);
      manager.logger = { log() {}, info() {}, warn() {}, error() {} };
      manager.focusBanner = document.getElementById('focus-session-banner');
      manager.focusBannerTimer = document.getElementById('focus-banner-timer');
      manager.focusTimerInterval = null;
      manager.statisticsRangeDays = 30;
      manager.rulesClient = {
        async replaceAll(rules) { return { rules }; },
        async clearRules() { return { rules: [] }; }
      };

      await callback({
        api,
        document,
        manager,
        SettingsManager,
        timeouts,
        intervals,
        setConfirmation(value) { confirmResult = value; },
        getReloadCount() { return reloadCount; }
      });
    }, {
      document,
      window: { location: { reload() { reloadCount += 1; } } }
    });
  } finally {
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
    globalThis.setInterval = previous.setInterval;
    globalThis.clearInterval = previous.clearInterval;
    if (previous.confirm) globalThis.confirm = previous.confirm;
    else delete globalThis.confirm;
  }
}

test('the settings constructor initializes defaults, focus elements, and the default 30-day range', async () => {
  await withSettingsManager(async ({ document, SettingsManager }) => {
    const original = SettingsManager.prototype.init;
    let initCalls = 0;
    SettingsManager.prototype.init = async function() { initCalls += 1; };
    try {
      const manager = new SettingsManager();
      assert.deepEqual(manager.defaultSettings, defaultSettings);
      assert.equal(manager.focusBanner, document.getElementById('focus-session-banner'));
      assert.equal(manager.focusBannerTimer, document.getElementById('focus-banner-timer'));
      assert.equal(manager.statisticsRangeDays, 30);
      assert.equal(initCalls, 1);
    } finally {
      SettingsManager.prototype.init = original;
    }
  });
});

test('settings initialization creates missing defaults and reflects them in the Options controls', async () => {
  await withSettingsManager(async ({ api, document, manager }) => {
    await manager.initializeSettings();
    assert.deepEqual(api.storage.sync.data.settings, defaultSettings);
    assert.equal(document.getElementById('mode-normal').checked, true);
    assert.equal(document.getElementById('showNotifications').checked, true);
    assert.equal(document.getElementById('focusSessionSound').checked, true);
    assert.equal(document.getElementById('enablePassword').checked, false);
  });
});

test('partial legacy settings receive new defaults without replacing existing choices', async () => {
  await withSettingsManager({ sync: { settings: { mode: 'strict', debugMode: true } } }, async ({
    api, document, manager
  }) => {
    await manager.initializeSettings();
    assert.equal(api.storage.sync.data.settings.mode, 'strict');
    assert.equal(api.storage.sync.data.settings.debugMode, true);
    assert.equal(api.storage.sync.data.settings.focusSessionSound, true);
    assert.equal(document.getElementById('mode-strict').checked, true);
    assert.equal(document.getElementById('enableDebug').checked, true);
  });
});

test('a settings read failure applies safe defaults and displays an error status', async () => {
  await withSettingsManager(async ({ api, document, manager }) => {
    api.storage.sync.getError = new Error('sync unavailable');
    await manager.initializeSettings();
    assert.equal(document.getElementById('mode-normal').checked, true);
    assert.equal(document.getElementById('statusMessage').textContent, 'errorloadingsettings');
    assert.match(document.getElementById('statusMessage').className, /error/);
  });
});

test('static settings retrieval initializes defaults, merges stored settings, and fails safely', async () => {
  await withSettingsManager(async ({ api, SettingsManager }) => {
    assert.deepEqual(await SettingsManager.getSettings(), defaultSettings);
    api.storage.sync.data.settings = { mode: 'strict', showNotifications: false };
    const merged = await SettingsManager.getSettings();
    assert.equal(merged.mode, 'strict');
    assert.equal(merged.showNotifications, false);
    assert.equal(merged.focusSessionSound, true);

    api.storage.sync.getError = new Error('sync unavailable');
    const previousError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await SettingsManager.getSettings(), defaultSettings);
    } finally {
      console.error = previousError;
    }
  });
});

test('reading settings from the UI preserves security, notifications, password, debug, and sound choices', async () => {
  await withSettingsManager(({ document, manager }) => {
    document.getElementById('mode-strict').checked = true;
    document.getElementById('confirmBeforeDelete').checked = true;
    document.getElementById('showNotifications').checked = false;
    document.getElementById('enablePassword').checked = true;
    document.getElementById('enableDebug').checked = true;
    document.getElementById('focusSessionSound').checked = false;

    assert.deepEqual(manager.getSettingsFromUI(), {
      mode: 'strict',
      confirmBeforeDelete: true,
      showNotifications: false,
      enablePassword: true,
      debugMode: true,
      focusSessionSound: false
    });
  });
});

test('saving settings merges only requested fields and reports write failures', async () => {
  await withSettingsManager({ sync: { settings: { ...defaultSettings, mode: 'strict' } } }, async ({
    api, document, manager
  }) => {
    await manager.saveSettings({ showNotifications: false });
    assert.equal(api.storage.sync.data.settings.mode, 'strict');
    assert.equal(api.storage.sync.data.settings.showNotifications, false);
    assert.equal(document.getElementById('statusMessage').textContent, 'settingssaved');

    api.storage.sync.setError = new Error('write rejected');
    await manager.saveSettings({ mode: 'normal' });
    assert.equal(document.getElementById('statusMessage').textContent, 'errorsavingsettings');
    assert.equal(api.storage.sync.data.settings.mode, 'strict');
  });
});

test('focus locking applies and removes the lock across every Options control group', async () => {
  await withSettingsManager(({ document, manager }) => {
    const ids = ['collapsible', 'search-filter-container', 'add-rule', 'add-whitelist-rule', 'table-wrapper'];
    manager.toggleUIAccessibility(true);
    assert.equal(ids.every(id => document.getElementById(id).classList.contains('focus-lock-active')), true);
    manager.toggleUIAccessibility(false);
    assert.equal(ids.some(id => document.getElementById(id).classList.contains('focus-lock-active')), false);
  });
});

test('active focus sessions show a live countdown, and expired sessions hide the banner and unlock controls', async () => {
  const now = Date.now();
  await withSettingsManager({ local: { focusSession: {
    focusActive: true, focusEndTime: now + 3_661_000, isHardcore: false, focusMode: 'blacklist'
  } } }, async ({ api, document, manager, intervals }) => {
    const previousNow = Date.now;
    Date.now = () => now;
    try {
      await manager.initFocusSessionBanner();
      assert.equal(manager.focusBanner.classList.contains('hidden'), false);
      assert.equal(manager.focusBannerTimer.textContent, '01:01:01');
      assert.equal(intervals.size, 1);
      assert.equal(document.getElementById('add-rule').classList.contains('focus-lock-active'), true);

      manager.updateBannerTimer(now + 61_000);
      assert.equal(manager.focusBannerTimer.textContent, '01:01');
      manager.updateBannerTimer(now);
      assert.equal(manager.focusBannerTimer.textContent, '00:00');
      assert.equal(manager.focusBanner.classList.contains('hidden'), true);
      assert.equal(intervals.size, 0);

      api.storage.local.data.focusSession = { focusActive: false, focusEndTime: 0 };
      await manager.initFocusSessionBanner();
      assert.equal(document.getElementById('add-rule').classList.contains('focus-lock-active'), false);
    } finally {
      Date.now = previousNow;
    }
  });
});

test('password checks allow unprotected settings and use the verification modal when enabled', async () => {
  await withSettingsManager({ sync: { settings: { ...defaultSettings } } }, async ({ api, manager }) => {
    assert.equal(await manager.checkPasswordProtection(), true);
    api.storage.sync.data.settings.enablePassword = true;
    const { PasswordUtils } = await import('../pro/password.js');
    const original = PasswordUtils.showPasswordModal;
    try {
      PasswordUtils.showPasswordModal = (type, callback) => {
        assert.equal(type, 'verify');
        callback(false);
      };
      assert.equal(await manager.checkPasswordProtection(), false);
      PasswordUtils.showPasswordModal = (_type, callback) => callback(true);
      assert.equal(await manager.checkPasswordProtection(), true);
    } finally {
      PasswordUtils.showPasswordModal = original;
    }
  });
});

test('settings controls persist radio, checkbox, debug, and focus-sound changes', async () => {
  await withSettingsManager({ sync: { settings: { ...defaultSettings } } }, async ({ api, document, manager }) => {
    manager.loadStatistics = async () => {};
    manager.setupEventListeners();

    const strict = document.getElementById('mode-strict');
    strict.checked = true;
    await strict.dispatch('change');
    assert.equal(api.storage.sync.data.settings.mode, 'strict');

    const confirmBeforeDelete = document.getElementById('confirmBeforeDelete');
    confirmBeforeDelete.checked = true;
    await confirmBeforeDelete.dispatch('change');
    assert.equal(api.storage.sync.data.settings.confirmBeforeDelete, true);

    const debug = document.getElementById('enableDebug');
    debug.checked = true;
    await debug.dispatch('change');
    assert.equal(api.storage.sync.data.settings.debugMode, true);

    const sound = document.getElementById('focusSessionSound');
    sound.checked = false;
    await sound.dispatch('change');
    assert.equal(api.storage.sync.data.settings.focusSessionSound, false);
  });
});

test('Free users cannot activate password protection or Pro-only bulk settings actions', async () => {
  await withSettingsManager({ sync: { credentials: { isPro: false }, settings: { ...defaultSettings } } }, async ({
    document, manager
  }) => {
    const invoked = [];
    manager.exportRules = () => invoked.push('export');
    manager.clearAllRules = () => invoked.push('clear');
    manager.resetSettings = () => invoked.push('reset');
    manager.loadStatistics = async () => {};
    manager.setupEventListeners();

    for (const id of ['enablePassword', 'exportRules', 'importRules', 'clearAllRules', 'resetSettings', 'clearStatistics']) {
      await document.getElementById(id).dispatch('click');
      assert.equal(document.getElementById('statusMessage').textContent, 'prorequired');
    }
    assert.deepEqual(invoked, []);
  });
});

test('Pro users can configure and remove password protection through the intended confirmation flow', async () => {
  await withSettingsManager({ sync: { credentials: { isPro: true }, settings: { ...defaultSettings } } }, async ({
    api, document, manager
  }) => {
    manager.loadStatistics = async () => {};
    const { PasswordUtils } = await import('../pro/password.js');
    const original = PasswordUtils.showPasswordModal;
    try {
      PasswordUtils.showPasswordModal = (type, callback) => {
        callback(type === 'set' ? 'salt:hash' : true);
      };
      manager.setupEventListeners();
      const toggle = document.getElementById('enablePassword');

      await toggle.dispatch('click');
      await new Promise(resolve => queueMicrotask(resolve));
      assert.equal(api.storage.sync.data.settings.enablePassword, true);
      assert.equal(api.storage.sync.data.settings.passwordHash, 'salt:hash');
      assert.equal(toggle.checked, true);

      await toggle.dispatch('click');
      await new Promise(resolve => queueMicrotask(resolve));
      assert.equal(api.storage.sync.data.settings.enablePassword, false);
      assert.equal(api.storage.sync.data.settings.passwordHash, null);
      assert.equal(toggle.checked, false);
    } finally {
      PasswordUtils.showPasswordModal = original;
    }
  });
});

test('statistics range controls accept seven and thirty days while ignoring unsupported ranges', async () => {
  await withSettingsManager(async ({ document, manager }) => {
    let loads = 0;
    manager.loadStatistics = async () => { loads += 1; };
    manager.setupEventListeners();
    const seven = document.getElementById('range-7');
    const thirty = document.getElementById('range-30');
    const invalid = document.getElementById('range-14');

    assert.equal(thirty.getAttribute('aria-pressed'), 'true');
    assert.equal(seven.textContent, '7 days');
    await seven.dispatch('click');
    assert.equal(manager.statisticsRangeDays, 7);
    assert.equal(seven.classList.contains('active'), true);
    assert.equal(thirty.getAttribute('aria-pressed'), 'false');
    assert.equal(loads, 1);

    await invalid.dispatch('click');
    assert.equal(manager.statisticsRangeDays, 7);
    assert.equal(loads, 1);
    await thirty.dispatch('click');
    assert.equal(manager.statisticsRangeDays, 30);
    assert.equal(loads, 2);
  });
});

test('rule counts use either the supplied mutation result or current browser storage', async () => {
  await withSettingsManager({ local: { rules: [{ id: 1 }, { id: 2 }] } }, async ({ api, document, manager }) => {
    await manager.loadRuleCount();
    assert.equal(document.getElementById('totalRules').textContent, 2);
    await manager.loadRuleCount([{ id: 3 }]);
    assert.equal(document.getElementById('totalRules').textContent, 1);
    api.storage.local.getError = new Error('storage unavailable');
    await manager.loadRuleCount();
    assert.equal(document.getElementById('totalRules').textContent, 1);
  });
});

test('statistics loading updates totals, today counters, both charts, and selected-range summaries', async () => {
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await withSettingsManager({ local: { statistics: {
    totalBlocked: 12,
    blockedToday: 4,
    totalRedirects: 8,
    redirectsToday: 2,
    successfulFocusSessions: 5,
    lastResetDate: today.toDateString(),
    dailyHistory: { [key]: { blocked: 4, redirected: 2, focusSessions: 1 } }
  } } }, async ({ document, manager }) => {
    manager.statisticsRangeDays = 7;
    await manager.loadStatistics();
    assert.equal(document.getElementById('totalBlocked').textContent, 12);
    assert.equal(document.getElementById('blockedToday').textContent, 4);
    assert.equal(document.getElementById('totalRedirects').textContent, 8);
    assert.equal(document.getElementById('redirectsToday').textContent, 2);
    assert.equal(document.getElementById('successfulFocusSessions').textContent, 5);
    assert.equal(document.getElementById('statsBlockedRangeTotal').textContent, 4);
    assert.equal(document.getElementById('statsRedirectedRangeTotal').textContent, 2);
    assert.equal(document.getElementById('statsFocusRangeTotal').textContent, 1);
    assert.equal(document.getElementById('statsActivityChart').querySelectorAll('.stats-chart-column').length, 7);
  });
});

test('rule exports include Rule Lists while removing passwords and legacy disabled-category settings', async () => {
  const apiOptions = {
    sync: { settings: { ...defaultSettings, enablePassword: true, passwordHash: 'private-hash', disabledCategories: ['adult'] } },
    local: {
      rules: [{ id: 8, blockURL: 'blocked.example' }],
      ruleLists: [{ id: 'general', name: 'General' }, { id: 'list-1', name: 'Work' }],
      activeRuleListId: 'list-1'
    }
  };
  await withSettingsManager(apiOptions, async ({ document, manager }) => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    let exportedBlob;
    const revoked = [];
    URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:test'; };
    URL.revokeObjectURL = url => revoked.push(url);
    try {
      await manager.exportRules();
      const exported = JSON.parse(await exportedBlob.text());
      assert.equal(exported.version, '5.1.7');
      assert.equal(exported.activeRuleListId, 'list-1');
      assert.equal(exported.rules[0].blockURL, 'blocked.example');
      assert.equal(exported.ruleLists.length, 2);
      assert.equal('enablePassword' in exported.settings, false);
      assert.equal('passwordHash' in exported.settings, false);
      assert.equal('disabledCategories' in exported.settings, false);
      assert.deepEqual(revoked, ['blob:test']);
      assert.equal(document.getElementById('statusMessage').textContent, 'rulesexported');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

test('rule imports reject unsupported files, malformed JSON, and payloads without a rules array', async () => {
  await withSettingsManager(async ({ document, manager }) => {
    await manager.importRules({ name: 'rules.txt', async text() { return ''; } });
    assert.equal(document.getElementById('statusMessage').textContent, 'errorinvalidfiletype');

    await manager.importRules({ name: 'rules.json', async text() { return '{ broken'; } });
    assert.match(document.getElementById('statusMessage').textContent, /not valid JSON/);

    await manager.importRules({ name: 'rules.JSON', async text() { return '{}'; } });
    assert.match(document.getElementById('statusMessage').textContent, /missing rules array/);
    await manager.importRules(null);
  });
});

test('confirmed rule imports preserve Rule Lists, activate the requested profile, and update the UI', async () => {
  await withSettingsManager(async ({ document, manager }) => {
    const importData = {
      rules: [{ id: 9, blockURL: 'imported.example' }],
      settings: { ...defaultSettings, mode: 'strict' },
      ruleLists: [{ id: 'general' }, { id: 'list-1', name: 'Work' }],
      activeRuleListId: 'list-1'
    };
    const calls = [];
    manager.rulesClient.replaceAll = async (...args) => {
      calls.push(args);
      return { rules: importData.rules, settings: importData.settings };
    };
    let statisticsLoads = 0;
    manager.loadStatistics = async () => { statisticsLoads += 1; };
    document.getElementById('importFileInput').value = '/tmp/rules.json';

    await manager.importRules({ name: 'rules.json', async text() { return JSON.stringify(importData); } });
    assert.deepEqual(calls, [[
      importData.rules,
      importData.settings,
      importData.ruleLists,
      'list-1'
    ]]);
    assert.equal(document.getElementById('mode-strict').checked, true);
    assert.equal(document.getElementById('totalRules').textContent, 1);
    assert.equal(document.getElementById('importFileInput').value, '');
    assert.equal(statisticsLoads, 1);
    assert.equal(document.getElementById('statusMessage').textContent, 'importedrules:1');
  });
});

test('cancelled imports never replace existing rules, and validation errors expose their safe error codes', async () => {
  await withSettingsManager(async ({ document, manager, setConfirmation }) => {
    const file = { name: 'rules.json', async text() { return '{"rules":[{"id":1}]}'; } };
    let called = false;
    manager.rulesClient.replaceAll = async () => { called = true; };
    setConfirmation(false);
    await manager.importRules(file);
    assert.equal(called, false);

    setConfirmation(true);
    manager.rulesClient.replaceAll = async () => {
      const error = new Error('Invalid imported rules');
      error.code = 'validation_failed';
      error.validationErrors = ['redirect_invalid'];
      throw error;
    };
    await manager.importRules(file);
    assert.match(document.getElementById('statusMessage').textContent, /redirect_invalid/);
  });
});

test('bulk rule clearing handles empty lists, cancellation, success, and worker failures', async () => {
  await withSettingsManager({ local: { rules: [] } }, async ({ api, document, manager, setConfirmation }) => {
    await manager.clearAllRules();
    assert.equal(document.getElementById('statusMessage').textContent, 'norulestoclear');

    api.storage.local.data.rules = [{ id: 1 }, { id: 2 }];
    let calls = 0;
    manager.rulesClient.clearRules = async () => { calls += 1; return { rules: [] }; };
    setConfirmation(false);
    await manager.clearAllRules();
    assert.equal(calls, 0);

    setConfirmation(true);
    await manager.clearAllRules();
    assert.equal(calls, 1);
    assert.equal(document.getElementById('totalRules').textContent, 0);
    assert.equal(document.getElementById('statusMessage').textContent, 'allrulescleared');

    manager.rulesClient.clearRules = async () => { throw new Error('bulk clear rejected'); };
    await manager.clearAllRules();
    assert.equal(document.getElementById('statusMessage').textContent, 'errorclearingrules');
  });
});

test('settings reset requires confirmation, restores defaults, and schedules one page reload', async () => {
  await withSettingsManager({ sync: { settings: { mode: 'strict' } } }, async ({
    api, document, manager, setConfirmation, timeouts, getReloadCount
  }) => {
    setConfirmation(false);
    await manager.resetSettings();
    assert.equal(api.storage.sync.data.settings.mode, 'strict');

    setConfirmation(true);
    await manager.resetSettings();
    assert.deepEqual(api.storage.sync.data.settings, defaultSettings);
    assert.equal(document.getElementById('statusMessage').textContent, 'resettodefaults');
    const reload = timeouts.find(timer => timer.delay === 1000);
    reload.handler();
    assert.equal(getReloadCount(), 1);

    api.storage.sync.setError = new Error('reset rejected');
    await manager.resetSettings();
    assert.equal(document.getElementById('statusMessage').textContent, 'errorresettingsettings');
  });
});

test('temporary status messages remove only their visibility class after the timeout', async () => {
  await withSettingsManager(({ document, manager, timeouts }) => {
    manager.showStatus('Completed', 'success');
    const status = document.getElementById('statusMessage');
    assert.equal(status.textContent, 'Completed');
    assert.equal(status.classList.contains('show'), true);
    timeouts.at(-1).handler();
    assert.equal(status.classList.contains('show'), false);
    assert.equal(status.classList.contains('success'), true);
  });
});

test('storage notifications refresh statistics only in local storage and refresh any changed focus session', async () => {
  await withSettingsManager(({ manager }) => {
    let statistics = 0;
    let focus = 0;
    manager.loadStatistics = () => { statistics += 1; };
    manager.initFocusSessionBanner = () => { focus += 1; };
    manager.handleStorageChange({ statistics: {} }, 'sync');
    manager.handleStorageChange({ statistics: {}, focusSession: {} }, 'local');
    assert.equal(statistics, 1);
    assert.equal(focus, 1);
  });
});

test('full settings initialization wires controls, loads counts and statistics, and initializes the focus banner', async () => {
  await withSettingsManager(async ({ manager }) => {
    const calls = [];
    manager.initializeSettings = async () => calls.push('settings');
    manager.setupEventListeners = () => calls.push('listeners');
    manager.loadRuleCount = () => calls.push('rules');
    manager.loadStatistics = () => calls.push('statistics');
    manager.initFocusSessionBanner = async () => calls.push('focus');
    await manager.init();
    assert.deepEqual(calls, ['settings', 'listeners', 'rules', 'statistics', 'focus']);
  });
});
