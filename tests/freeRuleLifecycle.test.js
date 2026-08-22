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
  deferConfirmation = false
}) {
  const alerts = [];
  const errors = [];
  const completions = [];
  let confirmation = null;
  let refreshCount = 0;
  const settings = {
    mode: strict ? 'strict' : 'normal',
    enablePassword: false
  };
  const SettingsManager = {
    async getSettings() {
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
    settings,
    isPro: false,
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
    getRefreshCount: () => refreshCount,
    async settle() {
      await Promise.all(completions);
    },
    async confirm() {
      assert.equal(typeof confirmation, 'function');
      await confirmation();
    }
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
