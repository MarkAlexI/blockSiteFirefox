import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const optionsSource = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

function getClassMember(source, opening, nextOpening) {
  const start = source.indexOf(`  ${opening}`);
  const end = source.indexOf(`\n  ${nextOpening}`, start + opening.length);
  assert.notEqual(start, -1, `${opening} was not found`);
  assert.notEqual(end, -1, `${opening} no longer ends before ${nextOpening}`);
  return source.slice(start, end);
}

test('paid rule-change authorization prompts only when password protection is enabled and fails closed', async () => {
  const method = getClassMember(
    optionsSource,
    'async authorizePasswordProtectedRuleChange()',
    'logRulesMutationFailure('
  );
  let settings = { enablePassword: true };
  let settingsError = null;
  let settingsReads = 0;
  let passwordPrompts = 0;
  const errors = [];
  const SettingsManager = {
    async getSettings(options) {
      settingsReads++;
      assert.deepEqual(options, { throwOnError: true });
      if (settingsError) throw settingsError;
      return settings;
    }
  };
  const Controller = new Function(
    'SettingsManager',
    't',
    `return class PasswordGate {\n${method}\n};`
  )(SettingsManager, key => key);
  const controller = new Controller();
  Object.assign(controller, {
    isPro: true,
    isLegacyUser: false,
    async promptForPassword() {
      passwordPrompts++;
      return false;
    },
    logger: { error() {} },
    rulesUI: { showErrorMessage(message) { errors.push(message); } }
  });

  assert.equal(await controller.authorizePasswordProtectedRuleChange(), false);
  assert.equal(passwordPrompts, 1);

  settings = { enablePassword: false };
  assert.equal(await controller.authorizePasswordProtectedRuleChange(), true);
  assert.equal(passwordPrompts, 1);

  controller.isPro = false;
  assert.equal(await controller.authorizePasswordProtectedRuleChange(), true);
  assert.equal(settingsReads, 2);

  controller.isLegacyUser = true;
  settingsError = new Error('sync storage unavailable');
  assert.equal(await controller.authorizePasswordProtectedRuleChange(), false);
  assert.deepEqual(errors, ['errorloadingsettings']);
});

for (const [label, source, args] of [
  ['Options', optionsSource, {
    opening: 'async handleRuleToggle(',
    next: 'async refreshProfileView()',
    call(controller, disabledByUser, isMuted = false) {
      return controller.handleRuleToggle(9, {
        listId: 'general',
        disabledByUser
      }, isMuted);
    }
  }],
  ['Popup', popupSource, {
    opening: 'async handleRuleToggle(',
    next: 'handleRulesMutationError(',
    call(controller, disabledByUser, isMuted = false) {
      return controller.handleRuleToggle(9, 'general', disabledByUser, isMuted);
    }
  }]
]) {
  test(`${label} requires authorization before disabling a rule but not before restoring it`, async () => {
    const method = getClassMember(source, args.opening, args.next);
    const Controller = new Function(
      'GENERAL_RULE_LIST_ID',
      `return class RuleToggle {\n${method}\n};`
    )('general');
    const controller = new Controller();
    const toggles = [];
    let authorizations = 0;
    let refreshes = 0;
    let authorized = false;
    Object.assign(controller, {
      async authorizePasswordProtectedRuleChange() {
        authorizations++;
        return authorized;
      },
      rulesClient: {
        async toggleRule(ruleId, listId) { toggles.push({ ruleId, listId }); }
      },
      async refreshProfileView() { refreshes++; },
      async loadRules() { refreshes++; },
      logRulesMutationFailure() {},
      handleRulesMutationError() {}
    });

    await args.call(controller, false);
    assert.equal(authorizations, 1);
    assert.deepEqual(toggles, []);

    authorized = true;
    await args.call(controller, false);
    assert.equal(authorizations, 2);
    assert.deepEqual(toggles, [{ ruleId: 9, listId: 'general' }]);
    assert.equal(refreshes, 1);

    authorized = false;
    await args.call(controller, true);
    assert.equal(authorizations, 2);
    assert.deepEqual(toggles, [
      { ruleId: 9, listId: 'general' },
      { ruleId: 9, listId: 'general' }
    ]);
    assert.equal(refreshes, 2);

    await args.call(controller, false, true);
    assert.equal(authorizations, 2);
    assert.equal(toggles.length, 2);
  });
}

test('Options protects destructive Rule List deletion and category disabling while allowing category restoration', async () => {
  const deleteMethod = getClassMember(
    optionsSource,
    'async handleRuleListDelete(list',
    'async handleCategoryToggle(category)'
  );
  const categoryMethod = getClassMember(
    optionsSource,
    'async handleCategoryToggle(category)',
    'cleanup()'
  );
  const Controller = new Function(
    'GENERAL_RULE_LIST_ID',
    't',
    `return class ProtectedMutations {\n${deleteMethod}\n${categoryMethod}\n};`
  )('general', key => key);
  const controller = new Controller();
  const mutations = [];
  let authorized = false;
  let authorizationCalls = 0;
  let disabledCategories = [];
  let refreshes = 0;
  Object.assign(controller, {
    isPro: true,
    isLegacyUser: false,
    activeRuleListId: 'list-1',
    async authorizePasswordProtectedRuleChange() {
      authorizationCalls++;
      return authorized;
    },
    ruleListsManager: {
      async getState() {
        return {
          lists: [{ id: 'list-1', disabledCategories: [...disabledCategories] }],
          activeRuleListId: 'list-1'
        };
      }
    },
    rulesClient: {
      async deleteRuleList(listId) { mutations.push(['delete', listId]); },
      async toggleCategory(category) { mutations.push(['category', category]); }
    },
    async refreshProfileView() { refreshes++; },
    logRulesMutationFailure() {},
    handleRulesMutationError() {},
    rulesUI: { showErrorMessage() {} }
  });
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;

  try {
    await controller.handleRuleListDelete({ id: 'list-1', name: 'Study' });
    await controller.handleCategoryToggle('social');
    assert.deepEqual(mutations, []);
    assert.equal(authorizationCalls, 2);
    assert.equal(refreshes, 1);

    disabledCategories = ['social'];
    await controller.handleCategoryToggle('social');
    assert.deepEqual(mutations, [['category', 'social']]);
    assert.equal(authorizationCalls, 2);
    assert.equal(refreshes, 2);

    authorized = true;
    await controller.handleRuleListDelete({ id: 'list-1', name: 'Study' });
    assert.deepEqual(mutations, [
      ['category', 'social'],
      ['delete', 'list-1']
    ]);
    assert.equal(refreshes, 3);
  } finally {
    if (previousConfirm) globalThis.confirm = previousConfirm;
    else delete globalThis.confirm;
  }
});

test('the rendered rule toggles use the protected handlers on both pages', () => {
  assert.match(
    optionsSource,
    /ruleId => this\.handleRuleToggle\(ruleId, assignment, isMuted, generation, revision\)/
  );
  assert.match(
    popupSource,
    /await this\.handleRuleToggle\([\s\S]*?disabledByUser,[\s\S]*?isMuted[\s\S]*?\);/
  );
});


test('list deletion conflict Options identifies the General address using existing localized labels', () => {
  const method = getClassMember(optionsSource, 'handleRulesMutationError(', 'async handleRuleToggle(');
  const messages = [];
  const translations = { alertruleexist: 'Правило вже існує', rulelist_general: 'Загальний' };
  const Controller = new Function('GENERAL_RULE_LIST_ID', 'MAX_RULES_LIMIT', 't', `return class ErrorPresentation {\n${method}\n};`)('general', 10, key => translations[key] || key);
  const controller = new Controller();
  controller.rulesUI = { showErrorMessage(message) { messages.push(message); } };
  controller.handleRulesMutationError({ code: 'rule_already_exists', conflict: { listId: 'general', blockURL: 'saved.example' } });
  controller.handleRulesMutationError({ code: 'rule_already_exists' });
  assert.deepEqual(messages, ['Правило вже існує\nЗагальний: saved.example', 'Правило вже існує']);
});

function staleOptionsDeferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('stale options row callbacks retain the generation of their displayed rule', async () => {
  const method = getClassMember(optionsSource, 'createRuleRow(', 'async handleRuleAssignmentDeletion(');
  const Controller = new Function('t', `return class Row {${method}};`)(key => key);
  const controller = new Controller();
  let callbacks;
  const calls = [];
  Object.assign(controller, {
    rulesUI: { createRuleDisplayRow(...args) { callbacks = args.slice(3, 6); return {}; } },
    toggleEditMode(...args) { calls.push(['edit', args.at(-2)]); },
    handleRuleAssignmentDeletion(...args) { calls.push(['remove', args.at(-2)]); },
    handleRuleToggle(...args) { calls.push(['toggle', args.at(-2)]); }
  });
  const rule = { id: 1, blockURL: 'old.example', category: 'social', isWhitelist: false };
  const assignment = { listId: 'general', disabledByUser: false };
  controller.createRuleRow({ rule, assignment, generation: 'captured' }, 0, true);
  controller.generation = 'replacement';
  callbacks[0]({}, 1, rule, assignment);
  callbacks[1]({ target: {} }, 1, assignment);
  callbacks[2](1);
  assert.deepEqual(calls, [['edit', 'captured'], ['remove', 'captured'], ['toggle', 'captured']]);
});

for (const [label, source, call] of [
  ['Options', optionsSource, controller => controller.handleRuleToggle(1, { listId: 'general', disabledByUser: false }, false, 'captured')],
  ['Popup', popupSource, controller => controller.handleRuleToggle(1, 'general', false, false, 'captured')]
]) {
  test(`stale options ${label} toggle keeps its captured generation while awaiting password`, async () => {
    const next = label === 'Options' ? 'async refreshProfileView(' : 'handleRulesMutationError(';
    const method = getClassMember(source, 'async handleRuleToggle(', next);
    const Controller = new Function('GENERAL_RULE_LIST_ID', `return class Toggle {${method}};`)('general');
    const controller = new Controller();
    const authorized = staleOptionsDeferred();
    const entered = staleOptionsDeferred();
    const calls = [];
    Object.assign(controller, {
      authorizePasswordProtectedRuleChange() { entered.resolve(); return authorized.promise; },
      rulesClient: { async toggleRule(...args) { calls.push(args); } },
      async refreshProfileView() {}, async loadRules() {}, logRulesMutationFailure() {}, handleRulesMutationError() {}
    });
    const pending = call(controller);
    await entered.promise;
    controller.generation = 'replacement';
    authorized.resolve(true);
    await pending;
    assert.deepEqual(calls, [[1, 'general', 'captured', null]]);
  });
}

test('stale options edit form and assignment removal keep the captured generation after password awaits', async () => {
  const edit = getClassMember(optionsSource, 'async toggleEditMode(', 'async saveEditedRule(');
  const save = getClassMember(optionsSource, 'async saveEditedRule(', 'async showAddRuleForm(');
  const entered = staleOptionsDeferred();
  const release = staleOptionsDeferred();
  const SettingsManager = { async getSettings() { entered.resolve(); return release.promise; } };
  const Controller = new Function('SettingsManager', 't', 'GENERAL_RULE_LIST_ID', `return class Edit {${edit}\n${save}};`)(SettingsManager, key => key, 'general');
  const controller = new Controller();
  const updates = []; const removals = []; let callbacks;
  Object.assign(controller, {
    isPro: true, isLegacyUser: false, statusElement: {},
    ruleListsManager: { async getState() { return { lists: [{ id: 'general', disabledCategories: [] }], activeRuleListId: 'general' }; } },
    rulesUI: { createRuleEditRow(...args) { callbacks = [args[3], args[5]]; return {}; } },
    rulesClient: { async updateRule(payload) { updates.push(payload); } },
    handleRuleAssignmentDeletion(...args) { removals.push(args.at(-2)); },
    async refreshProfileView() {}, logRulesMutationFailure() {}, handleRulesMutationError() {}
  });
  const rule = { id: 1, blockURL: 'old.example', redirectURL: '', category: 'social', isWhitelist: false };
  const assignment = { listId: 'general', disabledByUser: false };
  const pending = controller.toggleEditMode({ classList: { contains: () => false }, replaceWith() {} }, 1, rule, assignment, 'captured');
  await entered.promise;
  controller.generation = 'replacement';
  release.resolve({ enablePassword: false });
  await pending;
  await callbacks[0](1, 'general', 'edited.example', '', 'social', { blockingMode: 'always', schedule: null, dailyLimit: null }, 'general');
  callbacks[1](1, 'general', {});
  assert.equal(updates[0].expectedGeneration, 'captured');
  assert.deepEqual(removals, ['captured']);
});

test('stale options destructive confirmation callbacks keep the original generation', async () => {
  for (const [opening, next, invoke, methodName] of [
    ['async handleRuleAssignmentDeletion(', 'async handleRuleDeletion(', controller => controller.handleRuleAssignmentDeletion({ target: {} }, 1, 'general', 'captured'), 'removeAssignment'],
    ['async handleRuleDeletion(', 'async toggleEditMode(', controller => controller.handleRuleDeletion({ target: {} }, 1, 'captured'), 'deleteRule']
  ]) {
    const method = getClassMember(optionsSource, opening, next);
    const SettingsManager = { async getSettings() { return { mode: 'normal', enablePassword: false }; } };
    const Controller = new Function('SettingsManager', 't', `return class Delete {${method}};`)(SettingsManager, key => key);
    const controller = new Controller();let confirmation;const calls = [];
    Object.assign(controller, {
      isPro: true, rulesUI: { isDeleteConfirmationInProgress: () => false, handleRuleDeletion(_button, callback) { confirmation = callback; }, showSuccessMessage() {} },
      rulesClient: { async [methodName](...args) { calls.push(args); } },
      async refreshProfileView() {}, statusElement: {}, logRulesMutationFailure() {}, handleRulesMutationError() {}
    });
    await invoke(controller);
    controller.generation = 'replacement';
    await confirmation();
    assert.equal(calls[0].at(-2), 'captured');
    assert.equal(calls[0].at(-1), null);
  }
});

test('stale options Popup confirmation keeps both the displayed assignment and generation', async () => {
  const method = getClassMember(popupSource, 'async handleRuleDeletion(', 'async promptForPassword(');
  const SettingsManager = { async getSettings() { return { mode: 'normal', enablePassword: false }; } };
  const Controller = new Function('SettingsManager', 't', 'customAlert', 'GENERAL_RULE_LIST_ID', `return class Delete {${method}};`)(SettingsManager, key => key, () => {}, 'general');
  const controller = new Controller();let confirmation;const calls = [];
  Object.assign(controller, {
    isPro: true, activeRuleListId: 'list-1',
    rulesUI: { isDeleteConfirmationInProgress: () => false, handleRuleDeletion(_button, callback) { confirmation = callback; } },
    rulesClient: { async removeAssignment(...args) { calls.push(args); } },
    async loadRules() {}, logger: { info() {}, error() {} }
  });
  await controller.handleRuleDeletion({}, 1, 'old.example', { dataset: { isWhitelist: 'false' } }, 'captured', 'list-1');
  controller.activeRuleListId = 'list-2';
  await confirmation();
  assert.deepEqual(calls, [[1, 'list-1', 'captured', null]]);
});

for (const [label, source] of [['Options', optionsSource], ['Popup', popupSource]]) {
  test(`stale options ${label} refreshes its rule view after a stale rejection`, () => {
    const next = label === 'Options' ? 'async handleRuleToggle(' : 'async saveNewRule(';
    const method = getClassMember(source, 'handleRulesMutationError(', next);
    let refreshes = 0;const errors = [];
    const Controller = new Function('t', 'customAlert', `return class ErrorView {${method}};`)(key => key, message => errors.push(message));
    const controller = new Controller();
    Object.assign(controller, { rulesUI: { showErrorMessage(message) { errors.push(message); } }, async refreshProfileView() { refreshes++; }, async loadRules() { refreshes++; } });
    controller.handleRulesMutationError({ code: 'rules_state_changed' }, 'errorremovingrule');
    assert.equal(refreshes, 1);
    assert.deepEqual(errors, ['errorupdatingrules']);
  });
}


for (const [label, source, next] of [['Options', optionsSource, 'updateWhitelistButtonState('], ['Popup', popupSource, 'async loadStatisticsSummary(']]) {
  test(`stale options ${label} refreshes once when only the local generation changes`, () => {
    const method = getClassMember(source, 'setupStorageListeners(', next);
    let listener;let refreshes = 0;
    const api = { storage: { onChanged: { addListener(value) { listener = value; } } } };
    const Controller = new Function('chrome', 'browser', 'PRO_GUIDANCE_STORAGE_KEY', `return class Listener {${method}};`)(api, api, 'proGuidance');
    const controller = new Controller();
    Object.assign(controller, { async refreshProfileView() { refreshes++; }, async loadRules() { refreshes++; } });
    controller.setupStorageListeners();
    listener({ rulesGeneration: { oldValue: 'before', newValue: 'after' } }, 'local');
    assert.equal(refreshes, 1);
    listener({ rulesGeneration: { oldValue: 'after', newValue: 'next' }, dailyRuleUsage: { oldValue: { usageSeconds: {} }, newValue: { usageSeconds: { '1:general': 1 } } } }, 'local');
    assert.equal(refreshes, 2);
    listener({ dailyRuleUsage: { oldValue: { usageSeconds: { '1:general': 1 }, lastSample: 1 }, newValue: { usageSeconds: { '1:general': 1 }, lastSample: 2 } } }, 'local');
    listener({ rulesGeneration: { oldValue: 'before', newValue: 'after' } }, 'sync');
    assert.equal(refreshes, 2);
  });
}

for (const [method, next, invoke, expected] of [
  ['handleRuleListRename', 'handleRuleListDelete', controller => controller.handleRuleListRename({ id: 'list-1', name: 'Original' }, 'captured'), ['rename', 'list-1', 'Renamed', 'captured', null]],
  ['handleRuleListSelect', 'handleRuleListRename', controller => controller.handleRuleListSelect('list-1', 'captured'), ['select', 'list-1', 'captured', null]]
]) {
  test(`stale lists Options ${method} keeps the displayed generation`, async () => {
    const member = getClassMember(optionsSource, `async ${method}(`, `async ${next}(`);
    let controller; const calls = [];
    const Controller = new Function('GENERAL_RULE_LIST_ID', 'resolveRuleListContext', 't', 'prompt', `return class ListActions {${member}};`)(
      'general', (_lists, id) => id, key => key, () => { controller.generation = 'replacement'; return 'Renamed'; });
    controller = new Controller();
    Object.assign(controller, {
      ruleLists: [{ id: 'general' }, { id: 'list-1' }], generation: 'captured',
      rulesClient: {
        async renameRuleList(...args) { calls.push(['rename', ...args]); return {}; },
        async activateRuleList(...args) { calls.push(['select', ...args]); return {}; }
      },
      async refreshProfileView() {}, logRulesMutationFailure() {}, handleRulesMutationError() {}
    });
    await invoke(controller);
    assert.deepEqual(calls, [expected]);
  });
}

test('stale lists Options deletion keeps its generation through confirmation and password awaits', async () => {
  const member = getClassMember(optionsSource, 'async handleRuleListDelete(', 'async handleCategoryToggle(');
  let controller; let release; const password = new Promise(resolve => { release = resolve; });
  const calls = [];
  const Controller = new Function('GENERAL_RULE_LIST_ID', 't', 'confirm', `return class DeleteList {${member}};`)(
    'general', key => key, () => { controller.generation = 'replacement'; return true; });
  controller = new Controller();
  Object.assign(controller, {
    generation: 'captured', activeRuleListId: 'general',
    authorizePasswordProtectedRuleChange: () => password,
    rulesClient: { async deleteRuleList(...args) { calls.push(args); } },
    async refreshProfileView() {}, logRulesMutationFailure() {}, handleRulesMutationError() {}
  });
  const pending = controller.handleRuleListDelete({ id: 'list-1', name: 'Original' }, 'captured');
  controller.generation = 'another-import'; release(true); await pending;
  assert.deepEqual(calls, [['list-1', 'captured', null]]);
});

test('rule conflict Options row callbacks keep both generation and revision from the displayed snapshot', () => {
  const method = getClassMember(optionsSource, 'createRuleRow(', 'async handleRuleAssignmentDeletion(');
  const Controller = new Function('t', `return class Row {${method}};`)(key => key);
  const controller = new Controller();let callbacks;const calls = [];
  Object.assign(controller, {
    rulesUI: { createRuleDisplayRow(...args) { callbacks = args.slice(3, 6);return {}; } },
    toggleEditMode(...args) { calls.push(args.slice(-2)); },
    handleRuleAssignmentDeletion(...args) { calls.push(args.slice(-2)); },
    handleRuleToggle(...args) { calls.push(args.slice(-2)); }
  });
  const rule = { id: 1, category: 'social', isWhitelist: false };const assignment = { listId: 'general' };
  controller.createRuleRow({ rule, assignment, generation: 'bulk-generation', revision: 'displayed-revision' }, 0, true);
  controller.revision = 'latest-revision';
  callbacks[0]({}, 1, rule, assignment);callbacks[1]({ target: {} }, 1, assignment);callbacks[2](1);
  assert.deepEqual(calls, Array(3).fill(['bulk-generation', 'displayed-revision']));
});

for (const [label, source, invoke, next] of [
  ['Options', optionsSource, controller => controller.handleRuleToggle(1, { listId: 'general' }, false, 'generation', 'displayed-revision'), 'async refreshProfileView('],
  ['Popup', popupSource, controller => controller.handleRuleToggle(1, 'general', false, false, 'generation', 'displayed-revision'), 'handleRulesMutationError(']
]) {
  test(`rule conflict ${label} retains its revision while waiting for password authorization`, async () => {
    const method = getClassMember(source, 'async handleRuleToggle(', next);
    const Controller = new Function('GENERAL_RULE_LIST_ID', `return class Toggle {${method}};`)('general');
    const controller = new Controller();const entered = staleOptionsDeferred();const release = staleOptionsDeferred();const calls = [];
    Object.assign(controller, { authorizePasswordProtectedRuleChange() { entered.resolve();return release.promise; },
      rulesClient: { async toggleRule(...args) { calls.push(args); } }, async refreshProfileView() {}, async loadRules() {},
      logRulesMutationFailure() {}, handleRulesMutationError() {} });
    const pending = invoke(controller);await entered.promise;controller.revision = 'newer-revision';release.resolve(true);await pending;
    assert.deepEqual(calls, [[1, 'general', 'generation', 'displayed-revision']]);
  });
}

test('rule conflict Options edit and removal preserve the original revision through password waits', async () => {
  const edit = getClassMember(optionsSource, 'async toggleEditMode(', 'async saveEditedRule(');
  const save = getClassMember(optionsSource, 'async saveEditedRule(', 'async showAddRuleForm(');
  const entered = staleOptionsDeferred();const release = staleOptionsDeferred();
  const SettingsManager = { async getSettings() { entered.resolve();return release.promise; } };
  const Controller = new Function('SettingsManager', 't', 'GENERAL_RULE_LIST_ID', `return class Edit {${edit}\n${save}};`)(SettingsManager, key => key, 'general');
  const controller = new Controller();let callbacks;const updates = [];const removals = [];
  Object.assign(controller, { isPro: true, statusElement: {},
    ruleListsManager: { async getState() { return { lists: [{ id: 'general', disabledCategories: [] }], activeRuleListId: 'general' }; } },
    rulesUI: { createRuleEditRow(...args) { callbacks = [args[3], args[5]];return {}; } },
    rulesClient: { async updateRule(payload) { updates.push(payload); } }, handleRuleAssignmentDeletion(...args) { removals.push(args); },
    async refreshProfileView() {}, logRulesMutationFailure() {}, handleRulesMutationError() {} });
  const rule = { id: 1, category: 'social', isWhitelist: false };const assignment = { listId: 'general' };
  const pending = controller.toggleEditMode({ classList: { contains: () => false }, replaceWith() {} }, 1, rule, assignment, 'generation', 'displayed-revision');
  await entered.promise;controller.revision = 'newer-revision';release.resolve({ enablePassword: false });await pending;
  await callbacks[0](1, 'general', 'updated.example', '', 'social', { blockingMode: 'always' }, 'general');callbacks[1](1, 'general', {});
  assert.equal(updates[0].expectedGeneration, 'generation');assert.equal(updates[0].expectedRevision, 'displayed-revision');
  assert.deepEqual(removals[0].slice(-2), ['generation', 'displayed-revision']);
});

test('rule conflict Popup deletion confirmation keeps the displayed assignment generation and revision', async () => {
  const method = getClassMember(popupSource, 'async handleRuleDeletion(', 'async promptForPassword(');
  const SettingsManager = { async getSettings() { return { mode: 'normal', enablePassword: false }; } };
  const Controller = new Function('SettingsManager', 't', 'customAlert', 'GENERAL_RULE_LIST_ID', `return class Delete {${method}};`)(SettingsManager, key => key, () => {}, 'general');
  const controller = new Controller();let confirmation;const calls = [];
  Object.assign(controller, { isPro: true, activeRuleListId: 'list-1',
    rulesUI: { isDeleteConfirmationInProgress: () => false, handleRuleDeletion(_button, callback) { confirmation = callback; } },
    rulesClient: { async removeAssignment(...args) { calls.push(args); } }, async loadRules() {}, logger: { info() {}, error() {} } });
  await controller.handleRuleDeletion({}, 1, 'shown.example', { dataset: { isWhitelist: 'false' } }, 'generation', 'list-1', 'displayed-revision');
  controller.revision = 'newer-revision';controller.activeRuleListId = 'list-2';await confirmation();
  assert.deepEqual(calls, [[1, 'list-1', 'generation', 'displayed-revision']]);
});

test('list conflict Options rename preserves its displayed revision while a prompt sees newer state', async () => {
  const member = getClassMember(optionsSource, 'async handleRuleListRename(', 'async handleRuleListDelete(');
  let controller;const calls = [];
  const Controller = new Function('t', 'prompt', `return class RenameList {${member}};`)(key => key,
    () => { controller.revision = 'newer-state';return 'New name'; });
  controller = new Controller();Object.assign(controller, {
    rulesClient: { async renameRuleList(...args) { calls.push(args); } },
    async refreshProfileView() {}, logRulesMutationFailure() {}, handleRulesMutationError() {}
  });
  await controller.handleRuleListRename({ id: 'list-1', name: 'Displayed name' }, 'generation', 'displayed-revision');
  assert.deepEqual(calls, [['list-1', 'New name', 'generation', 'displayed-revision']]);
});

test('list conflict Options deletion preserves its revision through confirmation and password waits', async () => {
  const member = getClassMember(optionsSource, 'async handleRuleListDelete(', 'async handleCategoryToggle(');
  let controller;const entered = staleOptionsDeferred();const release = staleOptionsDeferred();const calls = [];
  const Controller = new Function('GENERAL_RULE_LIST_ID', 't', 'confirm', `return class DeleteList {${member}};`)(
    'general', key => key, () => { controller.revision = 'newer-state';return true; });
  controller = new Controller();Object.assign(controller, {
    activeRuleListId: 'general', authorizePasswordProtectedRuleChange() { entered.resolve();return release.promise; },
    rulesClient: { async deleteRuleList(...args) { calls.push(args); } },
    async refreshProfileView() {}, logRulesMutationFailure() {}, handleRulesMutationError() {}
  });
  const pending = controller.handleRuleListDelete({ id: 'list-1', name: 'Displayed name' }, 'generation', 'displayed-revision');
  await entered.promise;controller.revision = 'yet-newer-state';release.resolve(true);await pending;
  assert.deepEqual(calls, [['list-1', 'generation', 'displayed-revision']]);
});

test('list conflict Options selection keeps a vanished displayed ID instead of replacing it with General', async () => {
  const member = getClassMember(optionsSource, 'async handleRuleListSelect(', 'async handleRuleListRename(');
  const calls = [];let refreshes = 0;const errors = [];
  const Controller = new Function('GENERAL_RULE_LIST_ID', 'resolveRuleListContext', `return class SelectList {${member}};`)(
    'general', () => 'general');
  const controller = new Controller();Object.assign(controller, { ruleLists: [{ id: 'general' }], activeRuleListId: 'general',
    rulesClient: { async activateRuleList(...args) { calls.push(args);throw Object.assign(new Error('stale list'), { code: 'rules_state_changed' }); } },
    async refreshProfileView() { refreshes++; }, logRulesMutationFailure() {}, handleRulesMutationError(error) { errors.push(error.code); } });
  await controller.handleRuleListSelect('list-1', 'generation', 'displayed-revision');
  assert.deepEqual(calls, [['list-1', 'generation', 'displayed-revision']]);
  assert.deepEqual(errors, ['rules_state_changed']);assert.equal(controller.activeRuleListId, 'general');assert.equal(refreshes, 0);
});
