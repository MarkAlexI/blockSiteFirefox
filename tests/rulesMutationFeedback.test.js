import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RulesClient } from '../rules/rulesClient.js';
import { getRulesMutationFeedback } from '../rules/rulesMutationFeedback.js';
import { RulePacksUI } from '../options/rulePacksUI.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const sources = {
  Options: readFileSync(new URL('../options/options.js', import.meta.url), 'utf8'),
  Popup: readFileSync(new URL('../popup.js', import.meta.url), 'utf8')
};
function member(source, name) {
  const match = new RegExp('^  (?:async )?' + name + '\\(', 'm').exec(source);
  assert.ok(match, name + ' exists in the production controller');
  const rest = source.slice(match.index + 1);
  const next = /\n  (?:async )?[A-Za-z_$][\w$]*\(/.exec(rest);
  return source.slice(match.index, next ? match.index + 1 + next.index : source.indexOf('\n}', match.index));
}

async function withView(label, method, response, callback) {
  const document = new FakeDocument();
  const status = document.addElement('status');
  const api = createExtensionApi();
  const requests = [], alerts = [], errors = [], jobs = [];
  api.runtime.sendMessage = (message, done) => {
    requests.push(structuredClone(message));
    if (typeof done === 'function') { done(response); return; }
    return Promise.resolve(response);
  };
  await withExtensionEnvironment(api, async () => {
    const deps = {
      t: key => key, getRulesMutationFeedback, GENERAL_RULE_LIST_ID: 'general',
      countFreeRules: rules => rules.length, MAX_RULES_LIMIT: 10,
      SettingsManager: { async getSettings() { return { mode: 'normal', enablePassword: false }; } },
      prompt: () => 'Renamed', confirm: () => true,
      customAlert: message => alerts.push(message)
    };
    const code = member(sources[label], method) + '\n' + member(sources[label], 'showRulesMutationResult');
    const Controller = new Function(...Object.keys(deps), 'return class {\n' + code + '\n}')( ...Object.values(deps));
    const controller = new Controller();
    let refreshes = 0;
    Object.assign(controller, {
      isPro: true, isLegacyUser: false, rulesClient: new RulesClient(),
      activeRuleListId: 'general', ruleLists: [], ruleListNameInput: { value: 'Work' }, statusElement: status,
      rulesManager: { async getRules() { return []; } },
      async authorizePasswordProtectedRuleChange() { return true; },
      async refreshProfileView() { refreshes++; }, async loadRules() { refreshes++; },
      updateRuleListCreationState() {},
      logRulesMutationFailure(_label, error) { errors.push(error); },
      handleRulesMutationError(error) { errors.push(error); },
      logger: { error(_label, error) { errors.push(error); }, info() {} },
      rulesUI: {
        isDeleteConfirmationInProgress() { return false; },
        handleRuleDeletion(_button, onDelete) { jobs.push(onDelete()); },
        showSuccessMessage(message, element) { element.textContent = message; alerts.push(message); },
        showErrorMessage(message) { errors.push(new Error('Unexpected error feedback: ' + message)); }
      }
    });
    await callback({ controller, requests, alerts, errors, status, jobs, get refreshes() { return refreshes; } });
  }, { document });
}

const context = { generation: 'captured', revisions: { general: 7 } };
const blocking = { blockingMode: 'always', schedule: null, dailyLimit: null };
const optionsActions = [
  ['handleRuleToggle', 'rules:toggle', c => c.handleRuleToggle(1, { listId: 'general', disabledByUser: true }, false, 'captured', 3)],
  ['handleRuleAssignmentDeletion', 'rules:removeAssignment', c => c.handleRuleAssignmentDeletion({ target: {} }, 1, 'general', 'captured', 3)],
  ['handleRuleDeletion', 'rules:delete', c => c.handleRuleDeletion({ target: {} }, 1, 'captured', 3)],
  ['saveEditedRule', 'rules:update', c => c.saveEditedRule(1, 'general', 'saved.example', '', 'social', blocking, 'general', false, false, 'captured', 3, context.revisions)],
  ['saveNewRule', 'rules:add', c => c.saveNewRule('saved.example', '', 'social', blocking, 'general', {}, false, context)],
  ['handleRuleListCreate', 'rules:createList', c => c.handleRuleListCreate()],
  ['handleRuleListSelect', 'rules:activateList', c => c.handleRuleListSelect('general', 'captured', 7)],
  ['handleRuleListRename', 'rules:renameList', c => c.handleRuleListRename({ id: 'work', name: 'Work' }, 'captured', 7)],
  ['handleRuleListDelete', 'rules:deleteList', c => c.handleRuleListDelete({ id: 'work', name: 'Work' }, 'captured', 7)],
  ['handleCategoryToggle', 'rules:toggleCategory', c => c.handleCategoryToggle('social', { listId: 'general', generation: 'captured', revision: 7 }, false)]
];
for (const [method, type, act] of optionsActions) {
  for (const pending of [false, true]) {
    test(`Options ${method}: ${pending ? 'committed but pending' : 'applied'} rules finish one action and refresh`, async () => {
      await withView('Options', method, { success: true, rules: [], syncPending: pending }, async view => {
        await act(view.controller);
        await Promise.all(view.jobs);
        assert.deepEqual(view.errors, []);
        assert.equal(view.refreshes, 1, 'the saved state is refreshed even while blocking is pending');
        assert.equal(view.requests.length, 1, 'no mutation retry is sent');
        assert.equal(view.requests[0].type, type);
        if ('expectedGeneration' in view.requests[0].payload) assert.equal(view.requests[0].payload.expectedGeneration, 'captured');
        assert.deepEqual(view.alerts, pending ? ['ruleschangessavedpending'] : view.status.textContent ? [view.status.textContent] : []);
        if (pending) assert.equal(view.status.textContent, 'ruleschangessavedpending');
      });
    });
  }
}

const removable = () => ({ removed: false, remove() { this.removed = true; } });
const popupActions = [
  ['handleRuleToggle', 'rules:toggle', c => c.handleRuleToggle(1, 'general', true, false, 'captured', 3), ''],
  ['blockCurrentSite', 'rules:add', c => c.blockCurrentSite('saved.example', removable(), { ...context, listId: 'general' }), '+ 1'],
  ['saveNewRule', 'rules:add', c => c.saveNewRule({ value: 'saved.example' }, { value: '' }, removable(), {}, false, { ...context, listId: 'general' }), '+ 1'],
  ['handleRuleDeletion', 'rules:removeAssignment', c => c.handleRuleDeletion({}, 1, 'saved.example', { ...removable(), dataset: { isWhitelist: 'false' } }, 'captured', 'general', 3), '- 1'],
  ['handleRuleDeletion', 'rules:delete', c => c.handleRuleDeletion({}, 1, 'saved.example', { ...removable(), dataset: { isWhitelist: 'true' } }, 'captured', 'general', 3), '- 1']
];
for (const [method, type, act, successMessage] of popupActions) {
  for (const pending of [false, true]) {
    test(`Popup ${type}: ${pending ? 'pending warning replaces success' : 'applied feedback'}`, async () => {
      await withView('Popup', method, { success: true, syncPending: pending }, async view => {
        await act(view.controller);
        await Promise.all(view.jobs);
        assert.deepEqual(view.errors, []);
        assert.equal(view.requests.length, 1);
        assert.equal(view.requests[0].type, type);
        assert.deepEqual(view.alerts, pending ? ['ruleschangessavedpending'] : successMessage ? [successMessage] : []);
      });
    });
  }
}

for (const label of ['Options', 'Popup']) {
  test(`${label} warns when saved changes still have pending usage recovery`, async () => {
    const action = label === 'Options' ? optionsActions[0] : popupActions[0];
    await withView(label, action[0], { success: true, syncPending: false, dailyUsageSyncPending: true }, async view => {
      await action[2](view.controller);
      assert.deepEqual(view.alerts, ['ruleschangessavedpending']);
      assert.equal(view.refreshes, 1);
      assert.equal(view.requests.length, 1);
    });
  });
  test(`${label} rejected mutation keeps the normal error path and sends no retry`, async () => {
    const action = label === 'Options' ? optionsActions[0] : popupActions[0];
    await withView(label, action[0], { success: false, error: { code: 'rules_state_changed' } }, async view => {
      await action[2](view.controller);
      assert.ok(view.errors.some(error => error.code === 'rules_state_changed'));
      assert.deepEqual(view.alerts, []);
      assert.equal(view.requests.length, 1);
    });
  });
}

for (const pending of [false, true]) {
  test(`Rule Pack report preserves counts and entries with ${pending ? 'pending' : 'applied'} blocking`, async () => {
    const document = new FakeDocument();
    const status = document.addElement('rule-packs-status');
    await withExtensionEnvironment(createExtensionApi(), async () => {
      const ui = Object.create(RulePacksUI.prototype);
      ui.status = status;
      ui.showResultReport({ syncPending: pending, addedEntries: [{ blockURL: 'saved.example' }], duplicateEntries: [{ blockURL: 'duplicate.example' }], conflicts: [{ blockURL: 'conflict.example' }] });
      const texts = node => [node.textContent, ...node.children.flatMap(texts)];
      assert.equal(texts(status).includes('ruleschangessavedpending'), pending);
      for (const value of ['saved.example', 'duplicate.example', 'conflict.example']) assert.ok(texts(status).includes(value));
      assert.equal(status.classList.contains('success'), !pending);
      assert.equal(status.classList.contains('error'), pending);
    }, { document });
  });
}
