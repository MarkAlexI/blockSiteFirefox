import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const optionsSource = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
function member(source, opening, next) {
  const start = source.indexOf(`  ${opening}`);const end = source.indexOf(`\n  ${next}`, start + opening.length);
  assert.notEqual(start, -1);assert.notEqual(end, -1);return source.slice(start, end);
}
function controller(source, methods, deps = {}) {
  const code = methods.map(([a, b]) => member(source, a, b)).join('\n');
  const defaults = { GENERAL_RULE_LIST_ID: 'general', MAX_RULES_LIMIT: 10, countFreeRules: rules => rules.length, t: key => key, customAlert() {}, ...deps };
  const C = new Function(...Object.keys(defaults), `return class Controller {${code}}`)(...Object.values(defaults));
  const c = new C();Object.assign(c, { isPro: true, isLegacyUser: false, activeRuleListId: 'list-1',
    ruleLists: [{ id: 'general' }, { id: 'list-1' }], ruleListSnapshot: { generation: 'captured-generation', revisions: { 'list-1': 'captured-list' } },
    rulesManager: { async getRules() { return []; } }, async refreshProfileView() {}, statusElement: {},
    logRulesMutationFailure() {}, handleRulesMutationError(error) { throw error; } });
  return c;
}

function element() {
  return { value: '', style: {}, dataset: {}, children: [], listeners: {}, classList: { add() {} },
    appendChild(child) { this.children.push(child); }, addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute() {}, remove() { this.removed = true; }, focus() {} };
}

test('stale intent: category password wait preserves the profile and markers shown by the rendered checkbox', async () => {
  const c = controller(optionsSource, [['async handleCategoryToggle(', 'cleanup(']]);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  c.authorizePasswordProtectedRuleChange = async () => { entered(); return gate; };
  c.rulesClient = { async toggleCategory(...args) { calls.push(args); } };
  const shown = { listId: 'list-1', generation: 'shown-generation', revision: 'shown-list' };
  const pending = c.handleCategoryToggle('social', shown, false);
  try {
    await ready;
    c.activeRuleListId = 'general';
    c.ruleListSnapshot = { generation: 'new-generation', revisions: { general: 'new-list' } };
  } finally { release(true); }
  await pending;
  assert.deepEqual(calls, [['social', 'list-1', 'shown-generation', 'shown-list']]);
});

test('assignment context Options add form retains its displayed list snapshot until save', async () => {
  const c = controller(optionsSource, [['async showAddRuleForm(', 'async saveNewRule('], ['async saveNewRule(', 'async addRulePack(']], { resolveRuleListContext: (_lists, id) => id });
  let save;const requests = [];
  Object.assign(c, { rulesUI: { createAddRuleRow(fn) { save = fn;return {}; } }, rulesBody: { insertBefore() {} },
    rulesClient: { async addRule(payload) { requests.push(payload);return {}; } } });
  await c.showAddRuleForm();c.activeRuleListId = 'general';c.ruleListSnapshot = { generation: 'new-generation', revisions: { 'list-1': 'new-list' } };
  await save('typed.example', '', 'social', { blockingMode: 'always' }, 'list-1', {});
  assert.equal(requests[0].assignment.listId, 'list-1');assert.equal(requests[0].expectedGeneration, 'captured-generation');
  assert.deepEqual(requests[0].expectedListRevisions, { 'list-1': 'captured-list' });
});

test('assignment context Options edit retains source and target revisions through password waits', async () => {
  let release;const waiting = new Promise(resolve => { release = resolve; });
  const c = controller(optionsSource, [['async toggleEditMode(', 'async saveEditedRule('], ['async saveEditedRule(', 'async showAddRuleForm(']], { SettingsManager: { async getSettings() { return waiting; } } });
  let save;const requests = [];const revisions = { 'list-1': 'source', 'list-2': 'destination' };
  Object.assign(c, { ruleListsManager: { async getState() { return { lists: [], activeRuleListId: 'general' }; } },
    rulesUI: { createRuleEditRow(_rule, _assignment, _id, fn) { save = fn;return {}; } },
    async promptForPassword() { return true; }, rulesClient: { async updateRule(payload) { requests.push(payload); } } });
  const pending = c.toggleEditMode({ classList: { contains: () => false }, replaceWith() {} }, 1, { id: 1, category: 'social' }, { listId: 'list-1' }, 'captured-generation', 'captured-rule', revisions);
  c.ruleListSnapshot = { generation: 'new', revisions: {} };release({ enablePassword: true });await pending;
  await save(1, 'list-1', 'typed.example', '', 'social', { blockingMode: 'always' }, 'list-2');
  assert.equal(requests[0].expectedRevision, 'captured-rule');assert.deepEqual(requests[0].expectedListRevisions, revisions);
});

test('assignment context Popup captures destination before delayed rendering and later active changes', async () => {
  let render;const requests = [];
  const c = controller(popupSource, [['createRuleInputs(', 'createSaveButton('], ['createSaveButton(', 'async initFocusSession('], ['async saveNewRule(', 'async handleRuleDeletion(']], {
    document: { createElement: element }, configureUrlInput() {}, requestAnimationFrame() {}, setTimeout(fn) { render = fn; }
  });
  let row;Object.assign(c, { activeDisabledCategories: [], currentRuleCount: 0,
    rulesContainer: { insertAdjacentElement(_position, el) { row = el; } }, rulesClient: { async addRule(payload) { requests.push(payload); } } });
  c.createRuleInputs();c.activeRuleListId = 'general';c.ruleListSnapshot = { generation: 'new', revisions: {} };render();
  row.children[0].value = 'typed.example';const button = row.children.find(el => el.className === 'save-btn');await button.listeners.click();
  assert.equal(requests[0].assignment.listId, 'list-1');assert.equal(requests[0].expectedGeneration, 'captured-generation');
  assert.deepEqual(requests[0].expectedListRevisions, { 'list-1': 'captured-list' });assert.equal(row.removed, true);
});

test('assignment context Popup current-site button retains the destination chosen when displayed', async () => {
  const c = controller(popupSource, [['createBlockThisSiteButton(', 'isTouchDevice('], ['async blockCurrentSite(', 'createRuleInputs(']], { document: { createElement: element } });
  let button;const requests = [];
  Object.assign(c, { isTouchDevice: () => false, addRuleButton: { insertAdjacentElement(_position, el) { button = el; } },
    rulesClient: { async addRule(payload) { requests.push(payload); } } });
  c.createBlockThisSiteButton('current.example');c.activeRuleListId = 'general';c.ruleListSnapshot = { generation: 'new', revisions: {} };await button.listeners.click();
  assert.equal(requests[0].assignment.listId, 'list-1');assert.equal(requests[0].expectedGeneration, 'captured-generation');
  assert.deepEqual(requests[0].expectedListRevisions, { 'list-1': 'captured-list' });
});

test('assignment context rule packs send the displayed list generation and revisions', async () => {
  const c = controller(optionsSource, [['async addRulePack(', 'async handleRuleListCreate(']], { resolveRuleListContext: (_lists, id) => id });
  const requests = [];c.rulesClient = { async addMany(...args) { requests.push(args);return {}; } };
  await c.addRulePack('shopping', ['amazon'], null, { listId: 'list-1', generation: 'captured-generation', revisions: { 'list-1': 'captured-list' } });
  assert.deepEqual(requests, [['shopping', ['amazon'], null, 'list-1', 'captured-generation', { 'list-1': 'captured-list' }]]);
});


test('assignment context Options row binds edit revisions to the displayed snapshot', () => {
  const c = controller(optionsSource, [['createRuleRow(', 'async handleRuleAssignmentDeletion(']]);
  let callback;const calls = [];
  Object.assign(c, { rulesUI: { createRuleDisplayRow(_rule, _assignment, _index, fn) { callback = fn;return {}; } },
    toggleEditMode(...args) { calls.push(args); } });
  const rule = { id: 1, category: 'social' };const assignment = { listId: 'list-1' };
  c.createRuleRow({ rule, assignment, generation: 'shown-generation', revision: 'shown-rule', listRevisions: { 'list-1': 'shown-list' } }, 0, true);
  c.ruleListSnapshot = { generation: 'new', revisions: {} };callback({}, 1, rule, assignment);
  assert.deepEqual(calls[0].slice(-3), ['shown-generation', 'shown-rule', { 'list-1': 'shown-list' }]);
});

test('Rule Pack controller uses the dialog snapshot after replacement instead of current active selection', async () => {
  const c = controller(optionsSource, [['async addRulePack(', 'async handleRuleListCreate(']]);
  const requests = []; c.rulesClient = { async addMany(...args) { requests.push(args); return {}; } };
  const context = { listId: 'list-1', generation: c.ruleListSnapshot.generation, revisions: { ...c.ruleListSnapshot.revisions } };
  c.activeRuleListId = 'list-2'; c.ruleListSnapshot = { generation: 'replacement', revisions: { 'list-2': 'new' } };
  await c.addRulePack('shopping', ['amazon'], null, context);
  assert.deepEqual(requests[0].slice(3), ['list-1', 'captured-generation', { 'list-1': 'captured-list' }]);
  await assert.rejects(c.addRulePack('shopping', ['amazon']), error => error.code === 'rules_state_changed');
  assert.equal(requests.length, 1);
});

test('Popup current-site add cannot retarget during a delayed rules read and Pro-to-Free transition', async () => {
  const c = controller(popupSource, [['async blockCurrentSite(', 'createRuleInputs(']], { getRuleAssignment: () => null });
  let release; const gate = new Promise(resolve => { release = resolve; }); const requests = [];
  c.rulesManager.getRules = () => gate; c.rulesClient = { async addRule(payload) { requests.push(payload); } };
  const context = { listId: 'list-1', generation: 'shown', revisions: { 'list-1': 'shown-list' } };
  const pending = c.blockCurrentSite('current.example', { remove() {} }, context);
  c.isPro = false; c.activeRuleListId = 'general'; release([]); await pending;
  assert.equal(requests[0].assignment.listId, 'list-1');
  assert.equal(requests[0].expectedGeneration, 'shown');
  assert.deepEqual(requests[0].expectedListRevisions, context.revisions);
});

test('an open Popup form cannot turn a paid destination into General during suspension', async () => {
  const c = controller(popupSource, [['async saveNewRule(', 'async handleRuleDeletion(']]);
  const requests = []; c.rulesClient = { async addRule(payload) { requests.push(payload); } }; c.isPro = false;
  await c.saveNewRule({ value: 'typed.example' }, { value: '' }, { remove() {} }, {}, false,
    { listId: 'list-1', generation: 'shown', revisions: { 'list-1': 'shown-list' } });
  assert.equal(requests[0].assignment.listId, 'list-1');
  assert.equal(requests[0].expectedGeneration, 'shown');
});

for (const legacy of [false, true]) {
  test(`fresh Popup context still works for ${legacy ? 'Legacy custom' : 'Free General'}`, async () => {
    const c = controller(popupSource, [['async saveNewRule(', 'async handleRuleDeletion(']]);
    const requests = []; c.rulesClient = { async addRule(payload) { requests.push(payload); } };
    c.isPro = false; c.isLegacyUser = legacy;
    const listId = legacy ? 'list-1' : 'general';
    await c.saveNewRule({ value: 'fresh.example' }, { value: '' }, { remove() {} }, {}, false,
      { listId, generation: null, revisions: {} });
    assert.equal(requests[0].assignment.listId, listId);
  });
}
