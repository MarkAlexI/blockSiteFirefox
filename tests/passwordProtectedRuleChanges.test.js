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
    opening: 'async handleRuleToggle(ruleId, assignment, isMuted = false)',
    next: 'async refreshProfileView()',
    call(controller, disabledByUser, isMuted = false) {
      return controller.handleRuleToggle(9, {
        listId: 'general',
        disabledByUser
      }, isMuted);
    }
  }],
  ['Popup', popupSource, {
    opening: 'async handleRuleToggle(ruleId, listId, disabledByUser, isMuted = false)',
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
    'async handleRuleListDelete(list)',
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
    /ruleId => this\.handleRuleToggle\(ruleId, assignment, isMuted\)/
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
