import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDnrSynchronizer } from '../scripts/dnrSynchronizer.js';
import { createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { getRuleAssignment } from '../rules/ruleAssignments.js';
import { isRuleActiveNow } from '../rules/ruleActivation.js';
import { RulesClient } from '../rules/rulesClient.js';
import { createRulesIntentHandler } from '../rules/rulesIntentRouter.js';
import { migrateRuleSchema } from '../rules/rulesMigrationService.js';
import {
  createRulesMutationService,
  serializeRulesMutationError
} from '../rules/rulesMutationService.js';
import { MAX_RULES_LIMIT } from '../utils/constants.js';

const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const optionsSource = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const generalList = { id: 'general', name: 'General', disabledCategories: [] };

function copy(value) {
  return structuredClone(value);
}

function makeRule(id, blockURL, { listIds = ['general'], isWhitelist = false } = {}) {
  return {
    id,
    blockURL,
    redirectURL: '',
    category: isWhitelist ? 'whitelist' : 'social',
    isWhitelist,
    assignments: listIds.map(listId => ({
      listId,
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    }))
  };
}

function getClassMethod(source, methodName, nextMethodName) {
  const opening = '  async ' + methodName + '(';
  const start = source.indexOf(opening);
  const end = source.indexOf('\n  async ' + nextMethodName + '(', start + opening.length);

  assert.notEqual(start, -1, methodName + ' was not found in its real UI entry point');
  assert.notEqual(end, -1, methodName + ' no longer ends before ' + nextMethodName);
  return source.slice(start, end);
}

function createLifecycleHarness({
  rules = [],
  lists = [generalList],
  activeRuleListId = 'general',
  access = { isPro: false, isLegacyUser: false }
} = {}) {
  let storedRules = copy(rules);
  let storedLists = copy(lists);
  let activeListId = activeRuleListId;
  let currentAccess = copy(access);
  let dynamicRules = [];
  const dnrUpdates = [];
  const messages = [];
  const notifications = [];
  const previousBrowser = globalThis.browser;
  const previousChrome = globalThis.chrome;
  const logger = { log() {}, info() {}, warn() {}, error() {} };

  const declarativeNetRequest = {
    async getDynamicRules() {
      return copy(dynamicRules);
    },
    async updateDynamicRules(update) {
      const nextUpdate = copy(update);
      dnrUpdates.push(nextUpdate);
      const removedIds = new Set(nextUpdate.removeRuleIds || []);
      dynamicRules = dynamicRules.filter(rule => !removedIds.has(rule.id));
      dynamicRules.push(...copy(nextUpdate.addRules || []));
    }
  };
  const createDnrRule = createDnrRuleFactory(
    path => 'https://extension.invalid/' + path
  );
  const synchronizer = createDnrSynchronizer({
    getRules: async () => copy(storedRules),
    getRuleListState: async () => ({
      lists: copy(storedLists),
      activeRuleListId: activeListId
    }),
    getDailyUsage: async () => ({}),
    getFocusSessionState: async () => ({ focusActive: false }),
    isRuleActiveNow,
    createDnrRule,
    closeTabsMatchingRules: async () => {},
    declarativeNetRequest,
    logger
  });
  const rulesManager = {
    async getRules() {
      return copy(storedRules);
    },
    async saveRules(nextRules) {
      storedRules = copy(nextRules);
    },
    validateRule(blockURL) {
      return String(blockURL || '').trim()
        ? { isValid: true, errors: [] }
        : { isValid: false, errors: ['blockurl_empty'] };
    },
    checkConflict() {
      return null;
    },
    ruleExists() {
      return false;
    }
  };
  const ruleListsManager = {
    async getLists() {
      return copy(storedLists);
    },
    async getState() {
      return {
        lists: copy(storedLists),
        activeRuleListId: activeListId
      };
    },
    async saveLists(nextLists) {
      storedLists = copy(nextLists);
      return copy(storedLists);
    },
    async saveState(nextLists, nextActiveRuleListId) {
      storedLists = copy(nextLists);
      activeListId = nextActiveRuleListId;
      return {
        lists: copy(storedLists),
        activeRuleListId: activeListId
      };
    }
  };
  const service = createRulesMutationService({
    rulesManager,
    ruleListsManager,
    dnrSynchronizer: synchronizer,
    declarativeNetRequest,
    getAccess: async () => copy(currentAccess),
    getSettings: async () => ({
      disabledCategories: [],
      enablePassword: false,
      passwordHash: null
    }),
    saveSettings: async () => {},
    saveRulesAndLists: async (nextRules, nextLists, nextActiveRuleListId) => {
      storedRules = copy(nextRules);
      storedLists = copy(nextLists);
      if (nextActiveRuleListId) activeListId = nextActiveRuleListId;
    },
    maxRulesLimit: MAX_RULES_LIMIT,
    resolveRulePackEntries: () => ({ pack: null, entries: [] }),
    notifyRulesChanged(nextRules, extra) {
      notifications.push({ rules: copy(nextRules), extra: copy(extra) });
    },
    logger
  });
  const handler = createRulesIntentHandler(service);
  const extensionApi = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(copy(message));
        const response = Promise.resolve()
          .then(() => handler(message))
          .then(
            result => ({ success: true, ...result }),
            error => ({
              success: false,
              error: serializeRulesMutationError(error)
            })
          );
        if (typeof callback === 'function') {
          response.then(callback);
          return undefined;
        }
        return response;
      }
    }
  };

  globalThis.browser = extensionApi;
  globalThis.chrome = extensionApi;

  return {
    client: new RulesClient(),
    synchronizer,
    messages,
    notifications,
    dnrUpdates,
    getRules: () => copy(storedRules),
    getDynamicRules: () => copy(dynamicRules),
    setAccess(nextAccess) {
      currentAccess = copy(nextAccess);
    },
    async primeDnr() {
      await synchronizer.requestSync();
      dnrUpdates.length = 0;
    },
    restore() {
      globalThis.browser = previousBrowser;
      globalThis.chrome = previousChrome;
    }
  };
}

async function withLifecycle(options, callback) {
  const harness = createLifecycleHarness(options);

  try {
    await harness.primeDnr();
    await callback(harness);
  } finally {
    harness.restore();
  }
}

function createDeletionController({
  source,
  methodName,
  nextMethodName,
  harness,
  listId = 'general',
  strict = false,
  deferConfirmation = false,
  access = { isPro: false, isLegacyUser: false },
  passwordEnabled = false,
  cachedPasswordEnabled = passwordEnabled,
  passwordResult = true,
  settingsReadError = null
}) {
  const alerts = [];
  const errors = [];
  const completions = [];
  const settingsReads = [];
  let confirmation = null;
  let refreshCount = 0;
  let passwordPrompts = 0;
  const settings = {
    mode: strict ? 'strict' : 'normal',
    enablePassword: passwordEnabled
  };
  const SettingsManager = {
    async getSettings(options = {}) {
      settingsReads.push(copy(options));
      if (settingsReadError) {
        if (options.throwOnError) throw settingsReadError;
        return { mode: 'normal', enablePassword: false };
      }
      return settings;
    }
  };
  const customAlert = message => alerts.push(message);
  const t = key => key;
  const method = getClassMethod(source, methodName, nextMethodName);
  const Controller = new Function(
    'SettingsManager',
    'customAlert',
    't',
    'return class DeletionEntryPoint {\n' + method + '\n};'
  )(SettingsManager, customAlert, t);
  const controller = new Controller();

  Object.assign(controller, {
    settings: { ...settings, enablePassword: cachedPasswordEnabled },
    isPro: access.isPro === true,
    isLegacyUser: access.isLegacyUser === true,
    activeRuleListId: listId,
    rulesClient: harness.client,
    rulesUI: {
      isDeleteConfirmationInProgress: () => false,
      handleRuleDeletion(_button, onDelete, isStrictMode) {
        assert.equal(isStrictMode, strict);
        if (deferConfirmation) {
          confirmation = onDelete;
          return;
        }
        completions.push(Promise.resolve().then(onDelete));
      },
      showSuccessMessage(message) {
        alerts.push(message);
      },
      showErrorMessage(message) {
        errors.push(message);
      }
    },
    async refreshProfileView() {
      refreshCount++;
    },
    async loadRules() {
      refreshCount++;
    },
    async promptForPassword() {
      passwordPrompts++;
      return passwordResult;
    },
    logRulesMutationFailure(_label, error) {
      errors.push(error.code || error.message);
    },
    handleRulesMutationError(error) {
      errors.push(error.code || error.message);
    },
    logger: {
      info() {},
      error(_label, error) {
        errors.push(error && (error.code || error.message));
      }
    },
    statusElement: {}
  });

  return {
    controller,
    alerts,
    errors,
    settingsReads,
    getRefreshCount: () => refreshCount,
    getPasswordPromptCount: () => passwordPrompts,
    async settle() {
      await Promise.all(completions);
    },
    async confirm() {
      assert.equal(typeof confirmation, 'function');
      await confirmation();
    }
  };
}

function createRuleEditController({
  access = { isPro: false, isLegacyUser: false },
  passwordEnabled = false,
  passwordResult = true,
  settingsReadError = null
} = {}) {
  const errors = [];
  const settingsReads = [];
  const replaced = [];
  let passwordPrompts = 0;
  const SettingsManager = {
    async getSettings(options = {}) {
      settingsReads.push(copy(options));
      if (settingsReadError) {
        if (options.throwOnError) throw settingsReadError;
        return { enablePassword: false };
      }
      return { enablePassword: passwordEnabled };
    }
  };
  const method = getClassMethod(optionsSource, 'toggleEditMode', 'saveEditedRule');
  const Controller = new Function(
    'SettingsManager',
    't',
    'return class EditEntryPoint {\n' + method + '\n};'
  )(SettingsManager, key => key);
  const editRow = { classList: { add() {} } };
  const row = {
    classList: { contains: () => false },
    replaceWith(value) { replaced.push(value); }
  };
  const controller = new Controller();
  Object.assign(controller, {
    isPro: access.isPro === true,
    isLegacyUser: access.isLegacyUser === true,
    ruleListsManager: {
      async getState() {
        return { lists: [generalList], activeRuleListId: 'general' };
      }
    },
    rulesUI: {
      createRuleEditRow() { return editRow; },
      showErrorMessage(message) { errors.push(message); }
    },
    logger: { error() {} },
    async promptForPassword() {
      passwordPrompts++;
      return passwordResult;
    }
  });

  return {
    controller,
    row,
    editRow,
    replaced,
    errors,
    settingsReads,
    getPasswordPromptCount: () => passwordPrompts
  };
}

function createFocusController(response, { isPro = true, duration = '25' } = {}) {
  const alerts = [];
  const messages = [];
  let refreshCount = 0;
  const api = {
    runtime: {
      async sendMessage(message) {
        messages.push(copy(message));
        return copy(response);
      }
    }
  };
  const method = getClassMethod(popupSource, 'startFocusSession', 'stopFocusSession');
  const Controller = new Function(
    'browser',
    'chrome',
    'customAlert',
    't',
    'return class FocusEntryPoint {\n' + method + '\n};'
  )(api, api, message => alerts.push(message), key => key);
  const controller = new Controller();
  Object.assign(controller, {
    isPro,
    isLegacyUser: false,
    focusDurationInput: { value: duration },
    hardcoreModeCheckbox: { checked: false },
    focusModeSelect: { value: 'blacklist' },
    async updateFocusUI() {
      refreshCount++;
    }
  });

  return {
    controller,
    alerts,
    messages,
    getRefreshCount: () => refreshCount
  };
}

test('Popup shows the real browser quota failure instead of silently pretending Focus started', async () => {
  const view = createFocusController({
    success: false,
    code: 'dnr_rule_limit_reached',
    error: 'Browser unsafe dynamic rule limit reached (2/1)'
  });

  await view.controller.startFocusSession();

  assert.deepEqual(view.messages, [{
    type: 'start_focus_session',
    duration: 25,
    isHardcore: false,
    focusMode: 'blacklist'
  }]);
  assert.deepEqual(view.alerts, ['Browser unsafe dynamic rule limit reached (2/1)']);
  assert.equal(view.getRefreshCount(), 1);
});

test('Popup keeps successful Focus starts silent while refreshing their actual state', async () => {
  const view = createFocusController({ success: true });

  await view.controller.startFocusSession();

  assert.deepEqual(view.alerts, []);
  assert.equal(view.getRefreshCount(), 1);
});

test('Popup translates denied paid Focus settings and falls back safely for unknown failures', async () => {
  const denied = createFocusController({
    success: false,
    code: 'pro_required',
    error: 'pro_required'
  }, { isPro: false });
  await denied.controller.startFocusSession();
  assert.deepEqual(denied.alerts, ['prorequired']);

  const unknown = createFocusController({ success: false, code: 'dnr_sync_failed' });
  await unknown.controller.startFocusSession();
  assert.deepEqual(unknown.alerts, ['errorupdatingrules']);
  assert.equal(denied.getRefreshCount(), 1);
  assert.equal(unknown.getRefreshCount(), 1);
});

test('Popup Free deletion runs the real migrated-rule, worker, and DNR lifecycle', async () => {
  const migrated = migrateRuleSchema([{
    id: 17,
    blockURL: 'legacy-popup.example',
    redirectURL: '',
    disabledByUser: false,
    isWhitelist: false
  }]);

  assert.equal(migrated.migrated, true);
  await withLifecycle({ rules: migrated.rules }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness
    });
    const ruleDiv = {
      dataset: { isWhitelist: 'false' },
      remove() { assert.fail('Existing rules must be deleted through the worker'); }
    };

    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [17]);
    await view.controller.handleRuleDeletion({}, 17, 'legacy-popup.example', ruleDiv);
    await view.settle();

    assert.deepEqual(harness.messages, [{
      type: 'rules:removeAssignment',
      payload: { ruleId: 17, listId: 'general' }
    }]);
    assert.deepEqual(harness.getRules(), []);
    assert.deepEqual(harness.getDynamicRules(), []);
    assert.deepEqual(harness.dnrUpdates, [{ removeRuleIds: [17], addRules: [] }]);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
    assert.deepEqual(view.alerts, ['- 1']);
    assert.deepEqual(view.errors, []);
  });
});

test('Options Free deletion runs the real migrated-rule, worker, and DNR lifecycle', async () => {
  const migrated = migrateRuleSchema([{
    id: 23,
    blockURL: 'legacy-options.example',
    redirectURL: '',
    listId: 'general',
    disabledByUser: false,
    isWhitelist: false
  }]);

  await withLifecycle({ rules: migrated.rules }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleAssignmentDeletion',
      nextMethodName: 'handleRuleDeletion',
      harness
    });

    await view.controller.handleRuleAssignmentDeletion({ target: {} }, 23, 'general');
    await view.settle();

    assert.deepEqual(harness.messages, [{
      type: 'rules:removeAssignment',
      payload: { ruleId: 23, listId: 'general' }
    }]);
    assert.deepEqual(harness.getRules(), []);
    assert.deepEqual(harness.dnrUpdates, [{ removeRuleIds: [23], addRules: [] }]);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
    assert.equal(view.getRefreshCount(), 1);
    assert.deepEqual(view.errors, []);
  });
});

test('Popup removes a former-Pro assignment while the General target stays blocked', async () => {
  const migrated = migrateRuleSchema([{
    id: 31,
    blockURL: 'shared-legacy.example',
    redirectURL: '',
    category: 'social',
    disabledByUser: false,
    isWhitelist: false,
    listIds: ['general', 'list-1']
  }]);
  const lists = [
    generalList,
    { id: 'list-1', name: 'Old Pro list', disabledCategories: [] }
  ];

  await withLifecycle({ rules: migrated.rules, lists }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness,
      listId: 'list-1'
    });

    await view.controller.handleRuleDeletion(
      {},
      31,
      'shared-legacy.example',
      { dataset: { isWhitelist: 'false' }, remove() {} }
    );
    await view.settle();

    assert.deepEqual(harness.getRules()[0].assignments.map(item => item.listId), ['general']);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [31]);
    assert.deepEqual(harness.dnrUpdates, []);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('Options can delete an inherited whitelist rule without Pro access', async () => {
  await withLifecycle({
    rules: [
      makeRule(1, 'still-blocked.example'),
      makeRule(2, 'allowed.example', { isWhitelist: true })
    ]
  }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'toggleEditMode',
      harness
    });

    await view.controller.handleRuleDeletion({ target: {} }, 2);
    await view.settle();

    assert.deepEqual(harness.messages, [{
      type: 'rules:delete',
      payload: { ruleId: 2 }
    }]);
    assert.deepEqual(harness.getRules().map(rule => rule.id), [1]);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [1]);
    assert.deepEqual(harness.dnrUpdates, []);
    assert.equal(view.getRefreshCount(), 1);
  });
});

test('Popup checks current password settings instead of trusting an outdated cached snapshot', async () => {
  const access = { isPro: true, isLegacyUser: false };
  await withLifecycle({ rules: [makeRule(41, 'protected-popup.example')], access }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness,
      access,
      passwordEnabled: true,
      cachedPasswordEnabled: false,
      passwordResult: false
    });

    await view.controller.handleRuleDeletion(
      {}, 41, 'protected-popup.example', { dataset: { isWhitelist: 'false' }, remove() {} }
    );
    await view.settle();

    assert.deepEqual(view.settingsReads, [{ throwOnError: true }]);
    assert.equal(view.getPasswordPromptCount(), 1);
    assert.deepEqual(view.alerts, ['invalidpassword']);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [41]);
  });
});

test('Popup enforces password protection for genuine legacy users', async () => {
  const access = { isPro: false, isLegacyUser: true };
  await withLifecycle({ rules: [makeRule(42, 'legacy-protected.example')], access }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness,
      access,
      passwordEnabled: true,
      passwordResult: false
    });

    await view.controller.handleRuleDeletion(
      {}, 42, 'legacy-protected.example', { dataset: { isWhitelist: 'false' }, remove() {} }
    );

    assert.equal(view.getPasswordPromptCount(), 1);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.getRules().map(rule => rule.id), [42]);
  });
});

test('Popup rejects protected deletion when the settings read fails', async () => {
  const access = { isPro: true, isLegacyUser: false };
  await withLifecycle({ rules: [makeRule(43, 'unreadable-popup.example')], access }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness,
      access,
      settingsReadError: new Error('protected settings unavailable')
    });

    await view.controller.handleRuleDeletion(
      {}, 43, 'unreadable-popup.example', { dataset: { isWhitelist: 'false' }, remove() {} }
    );

    assert.deepEqual(view.settingsReads, [{ throwOnError: true }]);
    assert.equal(view.getPasswordPromptCount(), 0);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(view.alerts, ['errorremovingrule']);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [43]);
  });
});

test('Options rejects protected assignment removal when the settings read fails', async () => {
  const access = { isPro: true, isLegacyUser: false };
  await withLifecycle({ rules: [makeRule(44, 'unreadable-options.example')], access }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleAssignmentDeletion',
      nextMethodName: 'handleRuleDeletion',
      harness,
      access,
      settingsReadError: new Error('protected settings unavailable')
    });

    await view.controller.handleRuleAssignmentDeletion({ target: {} }, 44, 'general');

    assert.deepEqual(view.settingsReads, [{ throwOnError: true }]);
    assert.equal(view.getPasswordPromptCount(), 0);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [44]);
    assert.equal(view.errors.includes('protected settings unavailable'), true);
  });
});

test('Options rejects protected legacy whitelist deletion when the settings read fails', async () => {
  const access = { isPro: false, isLegacyUser: true };
  await withLifecycle({
    rules: [makeRule(45, 'legacy-whitelist.example', { isWhitelist: true })],
    access
  }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'toggleEditMode',
      harness,
      access,
      settingsReadError: new Error('legacy settings unavailable')
    });

    await view.controller.handleRuleDeletion({ target: {} }, 45);

    assert.deepEqual(view.settingsReads, [{ throwOnError: true }]);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.getRules().map(rule => rule.id), [45]);
    assert.equal(view.errors.includes('errorremovingrule'), true);
  });
});

test('Options keeps protected assignments unchanged when password verification is cancelled', async () => {
  const access = { isPro: true, isLegacyUser: false };
  await withLifecycle({ rules: [makeRule(46, 'cancelled-options.example')], access }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleAssignmentDeletion',
      nextMethodName: 'handleRuleDeletion',
      harness,
      access,
      passwordEnabled: true,
      passwordResult: false
    });

    await view.controller.handleRuleAssignmentDeletion({ target: {} }, 46, 'general');

    assert.equal(view.getPasswordPromptCount(), 1);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [46]);
  });
});

test('Options keeps protected whitelist rules unchanged when password verification is cancelled', async () => {
  const access = { isPro: false, isLegacyUser: true };
  await withLifecycle({
    rules: [makeRule(47, 'cancelled-whitelist.example', { isWhitelist: true })],
    access
  }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'toggleEditMode',
      harness,
      access,
      passwordEnabled: true,
      passwordResult: false
    });

    await view.controller.handleRuleDeletion({ target: {} }, 47);

    assert.equal(view.getPasswordPromptCount(), 1);
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.getRules().map(rule => rule.id), [47]);
  });
});

test('Free Popup deletion remains available if unrelated security settings cannot be read', async () => {
  await withLifecycle({ rules: [makeRule(48, 'free-popup-fallback.example')] }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness,
      settingsReadError: new Error('settings temporarily unavailable')
    });

    await view.controller.handleRuleDeletion(
      {}, 48, 'free-popup-fallback.example', { dataset: { isWhitelist: 'false' }, remove() {} }
    );
    await view.settle();

    assert.deepEqual(view.settingsReads, [{ throwOnError: false }]);
    assert.equal(view.getPasswordPromptCount(), 0);
    assert.deepEqual(harness.getRules(), []);
    assert.deepEqual(harness.getDynamicRules(), []);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('Free Options deletion remains available if unrelated security settings cannot be read', async () => {
  await withLifecycle({ rules: [makeRule(49, 'free-options-fallback.example')] }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleAssignmentDeletion',
      nextMethodName: 'handleRuleDeletion',
      harness,
      settingsReadError: new Error('settings temporarily unavailable')
    });

    await view.controller.handleRuleAssignmentDeletion({ target: {} }, 49, 'general');
    await view.settle();

    assert.deepEqual(view.settingsReads, [{ throwOnError: false }]);
    assert.deepEqual(harness.getRules(), []);
    assert.deepEqual(harness.getDynamicRules(), []);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('former Pro Popup users can remove custom assignments despite leftover password settings', async () => {
  const lists = [generalList, { id: 'list-1', name: 'Old Pro list', disabledCategories: [] }];
  await withLifecycle({
    rules: [makeRule(50, 'former-pro-popup.example', { listIds: ['general', 'list-1'] })],
    lists
  }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness,
      listId: 'list-1',
      passwordEnabled: true,
      cachedPasswordEnabled: true
    });

    await view.controller.handleRuleDeletion(
      {}, 50, 'former-pro-popup.example', { dataset: { isWhitelist: 'false' }, remove() {} }
    );
    await view.settle();

    assert.equal(view.getPasswordPromptCount(), 0);
    assert.deepEqual(harness.getRules()[0].assignments.map(item => item.listId), ['general']);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [50]);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('former Pro Options users can delete General rules despite leftover password settings', async () => {
  await withLifecycle({ rules: [makeRule(51, 'former-pro-options.example')] }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleAssignmentDeletion',
      nextMethodName: 'handleRuleDeletion',
      harness,
      passwordEnabled: true
    });

    await view.controller.handleRuleAssignmentDeletion({ target: {} }, 51, 'general');
    await view.settle();

    assert.equal(view.getPasswordPromptCount(), 0);
    assert.deepEqual(harness.getRules(), []);
    assert.deepEqual(harness.getDynamicRules(), []);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('authorized Pro Popup deletion preserves strict confirmation and browser blocking integrity', async () => {
  const access = { isPro: true, isLegacyUser: false };
  await withLifecycle({ rules: [makeRule(52, 'verified-popup.example')], access }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness,
      access,
      passwordEnabled: true,
      passwordResult: true,
      strict: true,
      deferConfirmation: true
    });

    await view.controller.handleRuleDeletion(
      {}, 52, 'verified-popup.example', { dataset: { isWhitelist: 'false' }, remove() {} }
    );
    assert.equal(view.getPasswordPromptCount(), 1);
    assert.deepEqual(harness.messages, []);

    await view.confirm();

    assert.deepEqual(harness.getRules(), []);
    assert.deepEqual(harness.getDynamicRules(), []);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('authorized legacy Options deletion preserves password checks and browser blocking integrity', async () => {
  const access = { isPro: false, isLegacyUser: true };
  await withLifecycle({ rules: [makeRule(53, 'verified-legacy.example')], access }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleAssignmentDeletion',
      nextMethodName: 'handleRuleDeletion',
      harness,
      access,
      passwordEnabled: true,
      passwordResult: true
    });

    await view.controller.handleRuleAssignmentDeletion({ target: {} }, 53, 'general');
    await view.settle();

    assert.equal(view.getPasswordPromptCount(), 1);
    assert.deepEqual(harness.getRules(), []);
    assert.deepEqual(harness.getDynamicRules(), []);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('Options refuses protected rule editing when settings cannot be read', async () => {
  const view = createRuleEditController({
    access: { isPro: true, isLegacyUser: false },
    settingsReadError: new Error('protected edit settings unavailable')
  });

  await view.controller.toggleEditMode(view.row, 61, makeRule(61, 'edit.example'), {});

  assert.deepEqual(view.settingsReads, [{ throwOnError: true }]);
  assert.deepEqual(view.replaced, []);
  assert.deepEqual(view.errors, ['errorupdatingrules']);
});

test('Options refuses legacy rule editing when password verification is cancelled', async () => {
  const view = createRuleEditController({
    access: { isPro: false, isLegacyUser: true },
    passwordEnabled: true,
    passwordResult: false
  });

  await view.controller.toggleEditMode(view.row, 62, makeRule(62, 'legacy-edit.example'), {});

  assert.equal(view.getPasswordPromptCount(), 1);
  assert.deepEqual(view.replaced, []);
});

test('former Pro users can edit their remaining Free rules despite leftover password settings', async () => {
  const view = createRuleEditController({ passwordEnabled: true });

  await view.controller.toggleEditMode(view.row, 63, makeRule(63, 'former-pro-edit.example'), {});

  assert.deepEqual(view.settingsReads, [{ throwOnError: false }]);
  assert.equal(view.getPasswordPromptCount(), 0);
  assert.deepEqual(view.replaced, [view.editRow]);
});

test('verified Pro users can edit rules after a successful password check', async () => {
  const view = createRuleEditController({
    access: { isPro: true, isLegacyUser: false },
    passwordEnabled: true,
    passwordResult: true
  });

  await view.controller.toggleEditMode(view.row, 64, makeRule(64, 'verified-edit.example'), {});

  assert.equal(view.getPasswordPromptCount(), 1);
  assert.deepEqual(view.replaced, [view.editRow]);
});

test('Free users replace one of three rules without leaving a stale DNR rule', async () => {
  await withLifecycle({
    rules: [
      makeRule(1, 'first.example'),
      makeRule(2, 'removed.example'),
      makeRule(3, 'third.example')
    ]
  }, async harness => {
    await harness.client.removeAssignment(2, 'general');
    await harness.client.addRule({
      blockURL: 'replacement.example',
      redirectURL: ''
    });

    assert.equal(harness.getRules().length, 3);
    assert.deepEqual(
      harness.getDynamicRules().map(rule => rule.condition.urlFilter).sort(),
      ['||first.example', '||replacement.example', '||third.example']
    );
    assert.deepEqual(harness.dnrUpdates[0], { removeRuleIds: [2], addRules: [] });
    assert.deepEqual(harness.dnrUpdates[1].removeRuleIds, []);
    assert.equal(harness.dnrUpdates[1].addRules[0].condition.urlFilter, '||replacement.example');
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('Free limit follows the production constant and reopens after deletion', async () => {
  const rules = Array.from({ length: MAX_RULES_LIMIT }, (_value, index) => {
    return makeRule(index + 1, 'limited-' + (index + 1) + '.example');
  });

  await withLifecycle({ rules }, async harness => {
    await assert.rejects(
      harness.client.addRule({ blockURL: 'too-many.example', redirectURL: '' }),
      error => error.code === 'rule_limit_reached'
    );
    assert.equal(harness.getRules().length, MAX_RULES_LIMIT);
    assert.deepEqual(harness.dnrUpdates, []);

    await harness.client.removeAssignment(MAX_RULES_LIMIT, 'general');
    await harness.client.addRule({ blockURL: 'replacement.example', redirectURL: '' });

    assert.equal(harness.getRules().length, MAX_RULES_LIMIT);
    assert.equal(harness.getDynamicRules().length, MAX_RULES_LIMIT);
    assert.equal(
      harness.getRules().some(rule => rule.blockURL === 'replacement.example'),
      true
    );
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('losing Pro access preserves cleanup and toggle while paid mutations stay locked', async () => {
  const lists = [
    generalList,
    { id: 'list-1', name: 'Old Pro list', disabledCategories: [] }
  ];

  await withLifecycle({
    rules: [makeRule(7, 'former-pro.example', { listIds: ['general', 'list-1'] })],
    lists,
    access: { isPro: true, isLegacyUser: false }
  }, async harness => {
    harness.setAccess({ isPro: false, isLegacyUser: false });

    await assert.rejects(
      harness.client.createRuleList('Still paid'),
      error => error.code === 'pro_required'
    );
    await assert.rejects(
      harness.client.clearRules(),
      error => error.code === 'pro_required'
    );
    await assert.rejects(
      harness.client.addRule({
        blockURL: 'new-pro.example',
        redirectURL: '',
        assignment: { listId: 'list-1' }
      }),
      error => error.code === 'pro_required'
    );

    await harness.client.removeAssignment(7, 'list-1');
    assert.deepEqual(harness.getRules()[0].assignments.map(item => item.listId), ['general']);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [7]);

    await harness.client.toggleRule(7, 'general');
    assert.equal(getRuleAssignment(harness.getRules()[0], 'general').disabledByUser, true);
    assert.deepEqual(harness.getDynamicRules(), []);

    await harness.client.toggleRule(7, 'general');
    assert.equal(getRuleAssignment(harness.getRules()[0], 'general').disabledByUser, false);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [7]);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('nineteen hidden Pro rules neither consume Free quota nor appear in General DNR', async () => {
  const lists = [
    generalList,
    { id: 'list-1', name: 'Study', disabledCategories: [] }
  ];
  const hiddenRules = Array.from({ length: 19 }, (_value, index) =>
    makeRule(index + 1, 'study-' + (index + 1) + '.example', { listIds: ['list-1'] })
  );
  const generalRules = Array.from({ length: MAX_RULES_LIMIT - 1 }, (_value, index) =>
    makeRule(index + 20, 'general-' + (index + 1) + '.example')
  );

  await withLifecycle({ rules: [...hiddenRules, ...generalRules], lists }, async harness => {
    assert.equal(harness.getDynamicRules().length, MAX_RULES_LIMIT - 1);

    await harness.client.addRule({ blockURL: 'tenth-general.example', redirectURL: '' });

    assert.equal(harness.getRules().length, 19 + MAX_RULES_LIMIT);
    assert.equal(harness.getDynamicRules().length, MAX_RULES_LIMIT);
    assert.equal(
      harness.getDynamicRules().some(rule => rule.condition.urlFilter.includes('study-')),
      false
    );
    await assert.rejects(
      harness.client.addRule({ blockURL: 'eleventh-general.example', redirectURL: '' }),
      error => error.code === 'rule_limit_reached'
    );
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('nineteen inherited General rules remain deletable until the Free quota reopens', async () => {
  const rules = Array.from({ length: 19 }, (_value, index) =>
    makeRule(index + 1, 'inherited-' + (index + 1) + '.example')
  );

  await withLifecycle({
    rules,
    lists: [generalList, { id: 'list-1', name: 'Study', disabledCategories: [] }]
  }, async harness => {
    await assert.rejects(
      harness.client.addRule({ blockURL: 'not-yet.example', redirectURL: '' }),
      error => error.code === 'rule_limit_reached'
    );

    for (let ruleId = 19; ruleId >= MAX_RULES_LIMIT; ruleId--) {
      await harness.client.removeAssignment(ruleId, 'general');
    }

    assert.equal(harness.getRules().length, MAX_RULES_LIMIT - 1);
    await harness.client.addRule({ blockURL: 'replacement.example', redirectURL: '' });
    assert.equal(harness.getRules().length, MAX_RULES_LIMIT);
    assert.equal(harness.getDynamicRules().length, MAX_RULES_LIMIT);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('migration ID repair preserves stable deletion and remaining DNR integrity', async () => {
  const migrated = migrateRuleSchema([
    { id: 9, blockURL: 'retained.example', isWhitelist: false },
    { id: 9, blockURL: 'removed.example', isWhitelist: false }
  ]);

  assert.equal(migrated.idsReset, true);
  assert.deepEqual(migrated.rules.map(rule => rule.id), [1, 2]);

  await withLifecycle({ rules: migrated.rules }, async harness => {
    await harness.client.removeAssignment(2, 'general');

    assert.deepEqual(harness.getRules().map(rule => rule.blockURL), ['retained.example']);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [1]);
    assert.deepEqual(harness.dnrUpdates, [{ removeRuleIds: [2], addRules: [] }]);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('strict-mode Popup keeps its existing delete confirmation before mutating rules', async () => {
  await withLifecycle({ rules: [makeRule(11, 'strict.example')] }, async harness => {
    const view = createDeletionController({
      source: popupSource,
      methodName: 'handleRuleDeletion',
      nextMethodName: 'promptForPassword',
      harness,
      strict: true,
      deferConfirmation: true
    });

    await view.controller.handleRuleDeletion(
      {},
      11,
      'strict.example',
      { dataset: { isWhitelist: 'false' }, remove() {} }
    );
    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [11]);

    await view.confirm();

    assert.deepEqual(harness.getRules(), []);
    assert.deepEqual(harness.getDynamicRules(), []);
    assert.equal((await harness.synchronizer.inspectState()).inSync, true);
  });
});

test('Options ignores assignment deletion when the Rule List ID is missing', async () => {
  await withLifecycle({ rules: [makeRule(19, 'untouched.example')] }, async harness => {
    const view = createDeletionController({
      source: optionsSource,
      methodName: 'handleRuleAssignmentDeletion',
      nextMethodName: 'handleRuleDeletion',
      harness
    });

    await view.controller.handleRuleAssignmentDeletion({ target: {} }, 19, '');
    await view.settle();

    assert.deepEqual(harness.messages, []);
    assert.deepEqual(harness.getRules().map(rule => rule.id), [19]);
    assert.deepEqual(harness.getDynamicRules().map(rule => rule.id), [19]);
    assert.equal(view.getRefreshCount(), 0);
  });
});
