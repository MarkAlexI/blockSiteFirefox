import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  countFreeRules,
  getAssignmentUsageSeconds,
  getRuleAssignment,
  getRuleAssignments
} from '../rules/ruleAssignments.js';
import { GENERAL_RULE_LIST_ID } from '../rules/ruleListsManager.js';
import { MAX_RULES_LIMIT } from '../utils/constants.js';

const optionsSource = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const ruleLists = [
  { id: GENERAL_RULE_LIST_ID, name: 'General', disabledCategories: [] },
  { id: 'list-1', name: 'Study', disabledCategories: ['news'] }
];

function clone(value) {
  return structuredClone(value);
}

function makeRule(id, listId, { isWhitelist = false, blockURL = null } = {}) {
  return {
    id,
    blockURL: blockURL || (listId + '-' + id + '.example'),
    redirectURL: '',
    category: isWhitelist ? 'whitelist' : 'social',
    isWhitelist,
    assignments: [{
      listId: isWhitelist ? GENERAL_RULE_LIST_ID : listId,
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    }]
  };
}

function makeRules({ general = 0, study = 0, whitelist = 0 } = {}) {
  const rules = [];
  let id = 1;
  for (let index = 0; index < general; index++) rules.push(makeRule(id++, GENERAL_RULE_LIST_ID));
  for (let index = 0; index < study; index++) rules.push(makeRule(id++, 'list-1'));
  for (let index = 0; index < whitelist; index++) {
    rules.push(makeRule(id++, GENERAL_RULE_LIST_ID, { isWhitelist: true }));
  }
  return rules;
}

function createController(source, methodName, nextMethodName, dependencies) {
  const start = source.indexOf('  async ' + methodName + '(');
  const nextAsync = source.indexOf('\n  async ' + nextMethodName + '(', start + 1);
  const nextSync = source.indexOf('\n  ' + nextMethodName + '(', start + 1);
  const boundaries = [nextAsync, nextSync].filter(index => index !== -1);
  const end = Math.min(...boundaries);

  assert.notEqual(start, -1, methodName + ' was not found in its real UI source');
  assert.equal(Number.isFinite(end), true, nextMethodName + ' was not found after ' + methodName);

  const method = source.slice(start, end);
  const Controller = new Function(
    ...Object.keys(dependencies),
    'return class ProductionEntryPoint {\n' + method + '\n};'
  )(...Object.values(dependencies));

  return new Controller();
}

function createOptionsProfileController({
  rules,
  isPro = false,
  isLegacyUser = false,
  activeRuleListId = 'list-1'
}) {
  const renderCalls = [];
  const gridCalls = [];
  const errors = [];
  const state = { lists: clone(ruleLists), activeRuleListId };
  const RuleListsUI = {
    updateListGrid(_container, lists, _rules, handlers) {
      gridCalls.push({ lists: clone(lists), activeRuleListId: handlers.activeRuleListId, handlers });
    },
    getDisplayName(list) {
      return list.name;
    }
  };
  const controller = createController(optionsSource, 'refreshProfileView', 'renderRules', {
    countFreeRules,
    getRuleAssignment,
    getRuleAssignments,
    RuleListsUI,
    CategoryUIManager: { updateCategoryGrid() {} },
    GENERAL_RULE_LIST_ID,
    MAX_RULES_LIMIT,
    document: { getElementById: () => null },
    t: key => key
  });

  Object.assign(controller, {
    isPro,
    isLegacyUser,
    profileRefreshId: 0,
    rulesManager: { getRulesSnapshot: async () => ({ rules: clone(rules), generation: null }) },
    ruleListsManager: { getState: async () => clone(state), getSnapshot: async () => ({ ...clone(state), generation: null }) },
    dailyLimitManager: { getUsageSeconds: async () => ({}) },
    ruleListsContainer: {},
    categoriesContainer: {},
    searchInput: { value: '' },
    categoryFilter: { value: 'all' },
    statusElement: {},
    settingsManager: { loadRuleCount() {} },
    rulesUI: {
      updateStatus() {},
      showErrorMessage(message) { errors.push(message); }
    },
    updateRuleListCreationState() {},
    renderRules(items, canEdit) {
      renderCalls.push({ items, canEdit });
    },
    handleRuleListSelect() {},
    handleRuleListRename() {},
    handleRuleListDelete() {},
    handleCategoryToggle() {},
    logger: { error(_message, error) { errors.push(error.message); } }
  });

  return { controller, renderCalls, gridCalls, errors, state };
}

function createOptionsAddController({ rules, isPro = false, isLegacyUser = false }) {
  const errors = [];
  const insertedRows = [];
  const requestedLists = [];
  const controller = createController(optionsSource, 'showAddRuleForm', 'saveNewRule', {
    countFreeRules,
    MAX_RULES_LIMIT,
    GENERAL_RULE_LIST_ID,
    resolveRuleListContext: (_lists, listId) => listId,
    t: key => key
  });

  Object.assign(controller, {
    isPro,
    isLegacyUser,
    activeRuleListId: 'list-1',
    ruleLists: clone(ruleLists),
    rulesManager: { getRules: async () => clone(rules) },
    rulesBody: {
      firstChild: null,
      insertBefore(row) { insertedRows.push(row); }
    },
    rulesUI: {
      showErrorMessage(message) { errors.push(message); },
      createAddRuleRow(_onSave, _onCancel, _hasPaidAccess, _isWhitelist, listId) {
        requestedLists.push(listId);
        return { remove() {} };
      }
    },
    logger: { info() {} }
  });

  return { controller, errors, insertedRows, requestedLists };
}

function createPopupProfileController({
  rules,
  isPro = false,
  isLegacyUser = false,
  activeRuleListId = 'list-1'
}) {
  const renderedRules = [];
  const errors = [];
  const statuses = [];
  const state = { lists: clone(ruleLists), activeRuleListId };
  const controller = createController(popupSource, 'loadRules', 'showBlockThisSiteButton', {
    countFreeRules,
    readRulesViewSnapshot: async () => ({ snapshot: { rules: clone(rules), generation: null },
      ruleListState: { ...clone(state), generation: null }, dailyUsageSeconds: {} }),
    getAssignmentUsageSeconds,
    getRuleAssignment,
    getRuleAssignments,
    GENERAL_RULE_LIST_ID,
    customAlert: message => errors.push(message),
    t: key => key
  });

  Object.assign(controller, {
    isPro,
    isLegacyUser,
    rulesManager: { getRulesSnapshot: async () => ({ rules: clone(rules), generation: null }) },
    ruleListsManager: { getState: async () => clone(state), getSnapshot: async () => ({ ...clone(state), generation: null }) },
    dailyLimitManager: { getUsageSeconds: async () => ({}) },
    rulesContainer: { innerHTML: '' },
    createRuleInputs(...args) {
      renderedRules.push({ blockURL: args[0], assignmentListId: args[7] });
    },
    updateStatus(count) { statuses.push(count); },
    showBlockThisSiteButton() {},
    logger: { error(_message, error) { errors.push(error.message); } }
  });

  return { controller, renderedRules, errors, statuses, state };
}

function createPopupSaveController({ rules, isPro = false, isLegacyUser = false }) {
  const alerts = [];
  const requests = [];
  let removed = false;
  const controller = createController(popupSource, 'saveNewRule', 'handleRuleDeletion', {
    countFreeRules,
    GENERAL_RULE_LIST_ID,
    MAX_RULES_LIMIT,
    customAlert: message => alerts.push(message),
    t: key => key
  });

  Object.assign(controller, {
    isPro,
    isLegacyUser,
    activeRuleListId: 'list-1',
    rulesManager: { getRules: async () => clone(rules) },
    rulesClient: { addRule: async payload => requests.push(clone(payload)) },
    logRulesMutationFailure() {},
    handleRulesMutationError(error) { alerts.push(error.code || error.message); }
  });

  return {
    controller,
    alerts,
    requests,
    row: { remove() { removed = true; } },
    wasRemoved: () => removed
  };
}

test('Options immediately falls back to General and ignores preserved custom profiles for Free', async () => {
  const rules = makeRules({ general: 1, study: 19, whitelist: 1 });
  const view = createOptionsProfileController({ rules });

  await view.controller.refreshProfileView();

  assert.deepEqual(view.errors, []);
  assert.equal(view.controller.activeRuleListId, GENERAL_RULE_LIST_ID);
  assert.deepEqual(view.controller.ruleLists.map(list => list.id), [GENERAL_RULE_LIST_ID]);
  assert.deepEqual(view.gridCalls[0].lists.map(list => list.id), [GENERAL_RULE_LIST_ID]);
  assert.equal(view.renderCalls[0].canEdit, true);
  assert.deepEqual(view.renderCalls[0].items.map(item => item.rule.id), [1, 21]);
  assert.equal(view.state.activeRuleListId, 'list-1');
  assert.equal(view.state.lists.length, 2);
});

test('Options preserves custom-profile access for Pro and legacy users', async () => {
  for (const access of [
    { isPro: true, isLegacyUser: false },
    { isPro: false, isLegacyUser: true }
  ]) {
    const view = createOptionsProfileController({
      rules: makeRules({ general: 1, study: 2 }),
      ...access
    });

    await view.controller.refreshProfileView();

    assert.equal(view.controller.activeRuleListId, 'list-1');
    assert.deepEqual(view.controller.ruleLists.map(list => list.id), ['general', 'list-1']);
    assert.deepEqual(view.renderCalls[0].items.map(item => item.rule.id), [2, 3]);
    assert.equal(view.renderCalls[0].canEdit, true);
  }
});

test('Options returns custom profiles after a Free user regains Pro access', async () => {
  const view = createOptionsProfileController({ rules: makeRules({ general: 1, study: 1 }) });

  await view.controller.refreshProfileView();
  assert.equal(view.controller.activeRuleListId, GENERAL_RULE_LIST_ID);

  view.controller.isPro = true;
  await view.controller.refreshProfileView();

  assert.equal(view.controller.activeRuleListId, 'list-1');
  assert.deepEqual(view.controller.ruleLists.map(list => list.id), ['general', 'list-1']);
  assert.equal(view.renderCalls.at(-1).items[0].rule.blockURL, 'list-1-2.example');
});

test('nineteen inherited General rules remain visible after Pro access expires', async () => {
  const view = createOptionsProfileController({ rules: makeRules({ general: 19 }) });

  await view.controller.refreshProfileView();

  assert.equal(view.controller.activeRuleListId, GENERAL_RULE_LIST_ID);
  assert.equal(view.renderCalls[0].items.length, 19);
  assert.equal(view.renderCalls[0].canEdit, false);
});

test('Options can add a General rule when nineteen hidden Study rules exist', async () => {
  const view = createOptionsAddController({ rules: makeRules({ study: 19 }) });

  await view.controller.showAddRuleForm();

  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.requestedLists, [GENERAL_RULE_LIST_ID]);
  assert.equal(view.insertedRows.length, 1);
});

test('Options continues enforcing exactly ten General blacklist rules', async () => {
  const view = createOptionsAddController({
    rules: makeRules({ general: MAX_RULES_LIMIT, study: 19, whitelist: 1 })
  });

  await view.controller.showAddRuleForm();

  assert.deepEqual(view.errors, ['rulelimitreached']);
  assert.deepEqual(view.requestedLists, []);
});

test('Options keeps the chosen Study profile when a Pro user adds a rule', async () => {
  const view = createOptionsAddController({
    rules: makeRules({ general: 19 }),
    isPro: true
  });

  await view.controller.showAddRuleForm();

  assert.deepEqual(view.requestedLists, ['list-1']);
});

test('Popup falls back to General before the worker finishes resetting a stale Study profile', async () => {
  const rules = makeRules({ general: 1, study: 19, whitelist: 1 });
  const view = createPopupProfileController({ rules });

  await view.controller.loadRules();

  assert.deepEqual(view.errors, []);
  assert.equal(view.controller.activeRuleListId, GENERAL_RULE_LIST_ID);
  assert.equal(view.controller.currentRuleCount, 1);
  assert.deepEqual(view.controller.ruleLists.map(list => list.id), [GENERAL_RULE_LIST_ID]);
  assert.deepEqual(view.renderedRules.map(rule => rule.assignmentListId), ['general', 'general']);
  assert.deepEqual(view.statuses, [2]);
  assert.equal(view.state.activeRuleListId, 'list-1');
});

test('Popup keeps custom profiles for Pro and legacy users', async () => {
  for (const access of [
    { isPro: true, isLegacyUser: false },
    { isPro: false, isLegacyUser: true }
  ]) {
    const view = createPopupProfileController({
      rules: makeRules({ general: 1, study: 2 }),
      ...access
    });

    await view.controller.loadRules();

    assert.equal(view.controller.activeRuleListId, 'list-1');
    assert.deepEqual(view.renderedRules.map(rule => rule.assignmentListId), ['list-1', 'list-1']);
    assert.equal(view.controller.currentRuleCount, 1);
  }
});

test('Popup saves a Free rule to General despite nineteen hidden rules and a stale Study profile', async () => {
  const view = createPopupSaveController({ rules: makeRules({ study: 19 }) });

  await view.controller.saveNewRule(
    { value: 'free.example' },
    { value: '' },
    view.row,
    {}
  );

  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].assignment.listId, GENERAL_RULE_LIST_ID);
  assert.equal(view.wasRemoved(), true);
  assert.deepEqual(view.alerts, ['+ 1']);
});

test('Popup save still rejects an eleventh General rule', async () => {
  const view = createPopupSaveController({
    rules: makeRules({ general: MAX_RULES_LIMIT, study: 19 })
  });

  await view.controller.saveNewRule(
    { value: 'eleventh.example' },
    { value: '' },
    view.row,
    {}
  );

  assert.deepEqual(view.requests, []);
  assert.deepEqual(view.alerts, ['rulelimitreached']);
  assert.equal(view.wasRemoved(), false);
});

test('Popup quick blocking can reuse a hidden Study target in the General profile', async () => {
  const existingRule = makeRule(1, 'list-1', { blockURL: 'shared.example' });
  const alerts = [];
  const requests = [];
  let removed = false;
  const controller = createController(popupSource, 'blockCurrentSite', 'createRuleInputs', {
    countFreeRules,
    getRuleAssignment,
    GENERAL_RULE_LIST_ID,
    MAX_RULES_LIMIT,
    customAlert: message => alerts.push(message),
    t: key => key
  });
  Object.assign(controller, {
    isPro: false,
    isLegacyUser: false,
    activeRuleListId: 'list-1',
    rulesManager: { getRules: async () => [clone(existingRule)] },
    rulesClient: { addRule: async payload => requests.push(clone(payload)) },
    logRulesMutationFailure() {},
    handleRulesMutationError(error) { alerts.push(error.code || error.message); }
  });

  await controller.blockCurrentSite('shared.example', { remove() { removed = true; } }, { listId: 'general', generation: null, revisions: {} });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].assignment.listId, GENERAL_RULE_LIST_ID);
  assert.equal(removed, true);
  assert.deepEqual(alerts, ['+ 1']);
});


test('stale lists Options callbacks retain the generation from their list snapshot', async () => {
  const view = createOptionsProfileController({ rules: [], isPro: true });
  const calls = [];
  view.controller.rulesManager.getRulesSnapshot = async () => ({ rules: [], generation: 'rules-snapshot' });
  view.controller.ruleListsManager.getSnapshot = async () => ({ ...clone(view.state), generation: 'list-snapshot' });
  view.controller.handleRuleListSelect = (...args) => calls.push(['select', ...args]);
  view.controller.handleRuleListRename = (...args) => calls.push(['rename', ...args]);
  view.controller.handleRuleListDelete = (...args) => calls.push(['delete', ...args]);
  await view.controller.refreshProfileView();
  const captured = view.gridCalls[0].handlers;
  view.controller.ruleListsManager.getSnapshot = async () => ({ ...clone(view.state), generation: 'replacement' });
  await view.controller.refreshProfileView();
  captured.onSelect('list-1');
  captured.onRename({ id: 'list-1', name: 'Original' });
  captured.onDelete({ id: 'list-1', name: 'Original' });
  assert.deepEqual(calls.map(call => [call[0], call.at(-2)]), [['select', 'list-snapshot'], ['rename', 'list-snapshot'], ['delete', 'list-snapshot']]);
});

test('rule conflict Options binds each rendered rule revision to the same rules snapshot', async () => {
  const rule = makeRule(1, 'list-1');
  const view = createOptionsProfileController({ rules: [rule], isPro: true });
  view.controller.rulesManager.getRulesSnapshot = async () => ({ rules: [rule], generation: 'rules-generation', revisions: { 1: 'displayed-revision' } });
  await view.controller.refreshProfileView();
  assert.deepEqual(view.errors, []);
  assert.equal(view.renderCalls[0].items[0].generation, 'rules-generation');
  assert.equal(view.renderCalls[0].items[0].revision, 'displayed-revision');
});

test('list conflict Options grid callbacks bind revisions from their own displayed list snapshot', async () => {
  const view = createOptionsProfileController({ rules: [], isPro: true });const calls = [];
  view.controller.rulesManager.getRulesSnapshot = async () => ({ rules: [], generation: 'different-rules-generation', revisions: { 1: 'rule-revision' } });
  view.controller.ruleListsManager.getSnapshot = async () => ({ ...clone(view.state), generation: 'list-generation', revisions: { 'list-1': 'displayed-list-revision' } });
  for (const method of ['handleRuleListSelect', 'handleRuleListRename', 'handleRuleListDelete']) view.controller[method] = (...args) => calls.push(args.slice(-2));
  await view.controller.refreshProfileView();const captured = view.gridCalls[0].handlers;
  view.controller.ruleListsManager.getSnapshot = async () => ({ ...clone(view.state), generation: 'new-generation', revisions: { 'list-1': 'new-list-revision' } });
  await view.controller.refreshProfileView();captured.onSelect('list-1');captured.onRename({ id: 'list-1' });captured.onDelete({ id: 'list-1' });
  assert.deepEqual(view.errors, []);assert.deepEqual(calls, Array(3).fill(['list-generation', 'displayed-list-revision']));
});
