import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeDocument } from './helpers/extensionTestHarness.js';
import { getRuleAssignment, getRuleAssignments } from '../rules/ruleAssignments.js';

const guardSource = readFileSync(new URL('../options/optionsRecovery.js', import.meta.url), 'utf8');
const optionsSource = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const classSource = optionsSource.slice(optionsSource.indexOf('class OptionsPage {'), optionsSource.indexOf('const optionsPage = new OptionsPage();'));
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture({ brokenI18n = false } = {}) {
  const document = new FakeDocument(), timers = new Map();
  const ids = ['options-recovery', 'options-recovery-message', 'options-recovery-reload', 'rules-loading-message',
    'quick-add-rule', 'add-rule', 'add-whitelist-rule', 'open-rule-packs', 'rule-packs-dialog',
    'rule-packs-add', 'rule-packs-close', 'rule-lists-panel', 'categories-container', 'rules-table', 'rules-management-panel'];
  for (const id of ids) document.addElement(id);
  const banner = document.getElementById('options-recovery');banner.hidden = true;
  const paid = document.getElementById('add-whitelist-rule');paid.disabled = true;
  const dialog = document.getElementById('categories-container');dialog.inert = true;
  let serial = 0, reloads = 0;
  const window = { location: { reload() { reloads++; } }, addEventListener() {} };
  const context = vm.createContext({ document, window,
    chrome: { i18n: { getMessage(key) { if (brokenI18n) throw new Error('Extension context invalidated.'); return key; } } },
    setTimeout(fn, ms) { const id = ++serial;timers.set(id, { fn, ms });return id; },
    clearTimeout(id) { timers.delete(id); },
    getRuleAssignment, getRuleAssignments, GENERAL_RULE_LIST_ID: 'general', MAX_RULES_LIMIT: 10,
    countFreeRules: rules => rules.length, checkRulesConnection: async () => {}, t: key => key
  });
  vm.runInContext(guardSource, context);
  const guard = window.bdOptionsRecovery;
  const state = { lists: [{ id: 'general', name: 'General', disabledCategories: [] }],
    activeRuleListId: 'general', generation: 'generation', revisions: { general: 1 } };
  const snapshot = { rules: [{ id: 1, blockURL: 'saved.example', category: 'social',
    isWhitelist: false, assignments: [{ listId: 'general', blockingMode: 'always' }] }], generation: 'generation', revisions: { 1: 1 } };
  vm.runInContext(classSource + '\nglobalThis.OptionsClass = OptionsPage;', context);
  const page = Object.create(context.OptionsClass.prototype), renders = [], errors = [];
  Object.assign(page, { profileRefreshId: 0, disposed: false, isPro: true, isLegacyUser: false,
    rulesManager: { getRulesSnapshot: async () => structuredClone(snapshot) },
    ruleListsManager: { getSnapshot: async () => structuredClone(state) },
    dailyLimitManager: { getUsageSeconds: async () => ({}) },
    ruleListsContainer: null, categoriesContainer: null,
    searchInput: { value: '' }, categoryFilter: { value: 'all' },
    updateRuleListCreationState() {}, renderRules(items) { renders.push(items); },
    rulesUI: { updateStatus() {}, showErrorMessage(message) { errors.push(message); } },
    logger: { error() {} }, settingsManager: null
  });
  return { document, context, page, renders, errors, guard, banner, timers, paid, dialog,
    get reloads() { return reloads; },
    expire() { const pending = [...timers.values()];timers.clear();for (const timer of pending) timer.fn(); }
  };
}

test('independent bootstrap reports a module that never starts, without changing browser or data', async () => {
  const f = fixture();
  assert.equal(f.guard.state, 'loading');
  assert.equal(f.document.getElementById('add-rule').inert, true);
  assert.equal(f.timers.size, 1);
  f.expire();
  assert.equal(f.guard.state, 'failed');
  assert.equal(f.banner.hidden, false);
  assert.equal(f.reloads, 0, 'recovery never reloads automatically');
  assert.equal(f.document.getElementById('rules-loading-message').textContent, 'options_rules_unavailable');
  await f.document.getElementById('options-recovery-reload').click();
  assert.equal(f.reloads, 1, 'the user explicitly reloads only this page');
});

test('recovery remains readable even when the old context cannot call i18n', () => {
  const f = fixture({ brokenI18n: true });f.expire();
  assert.match(f.document.getElementById('options-recovery-message').textContent, /restart your browser/);
  assert.equal(f.document.getElementById('options-recovery-reload').textContent, 'Reload page');
});

test('a healthy refresh releases only recovery locks and preserves paid or pre-existing restrictions', async () => {
  const f = fixture();await f.page.refreshProfileView();
  assert.equal(f.guard.state, 'ready');
  assert.equal(f.banner.hidden, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.document.getElementById('add-rule').inert, false);
  assert.equal(f.paid.disabled, true);
  assert.equal(f.dialog.inert, true);
  assert.equal(f.renders[0].length, 1);
});

test('a genuinely empty successful snapshot is ready rather than an update failure', async () => {
  const f = fixture();
  f.page.rulesManager.getRulesSnapshot = async () => ({ rules: [], generation: null, revisions: {} });
  await f.page.refreshProfileView();
  assert.equal(f.guard.state, 'ready');
  assert.equal(f.renders[0].length, 0);
  assert.equal(f.banner.hidden, true);
});

test('an unanswered storage read stays distinct from an empty list and can recover on a current late response', async () => {
  const f = fixture(), read = deferred();
  f.page.dailyLimitManager.getUsageSeconds = () => read.promise;
  const refresh = f.page.refreshProfileView();await settle();
  for (let i = 0;i < 4;i++) f.guard.begin();
  assert.equal(f.timers.size, 1, 'repeated requests do not defer the deadline');
  f.expire();
  assert.equal(f.guard.state, 'failed');
  assert.equal(f.renders.length, 0);
  read.resolve({});await refresh;
  assert.equal(f.guard.state, 'ready');
  assert.equal(f.renders[0].length, 1);
});

test('old failures cannot replace a newer successful rules view with a recovery warning', async () => {
  const f = fixture(), read = deferred();let count = 0;
  const current = f.page.rulesManager.getRulesSnapshot;
  f.page.rulesManager.getRulesSnapshot = () => ++count === 1 ? read.promise : current();
  const old = f.page.refreshProfileView();await settle();
  await f.page.refreshProfileView();
  read.reject(new Error('old invalidated context'));await old;
  assert.equal(f.guard.state, 'ready');
  assert.equal(f.errors.length, 0);
  assert.equal(f.renders.length, 1);
});

test('disposed pages cannot render a late snapshot or show a recovery warning', async () => {
  const f = fixture(), read = deferred();
  f.page.dailyLimitManager.getUsageSeconds = () => read.promise;
  const refresh = f.page.refreshProfileView();await settle();
  f.page.disposed = true;f.guard.dispose();read.resolve({});await refresh;
  assert.equal(f.timers.size, 0);
  assert.equal(f.renders.length, 0);
  assert.equal(f.errors.length, 0);
});

test('a dead background connection keeps an apparently readable snapshot locked', async () => {
  const f = fixture();
  f.context.checkRulesConnection = async () => { throw new Error('Receiving end does not exist'); };
  await f.page.refreshProfileView();
  assert.equal(f.guard.state, 'failed');
  assert.equal(f.renders.length, 0);
  assert.equal(f.document.getElementById('add-rule').inert, true);
});

test('the fallback script loads independently before the Options modules', () => {
  const html = readFileSync(new URL('../options/options.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\.\/optionsRecovery\.js" defer><\/script>/);
  assert.ok(html.indexOf('optionsRecovery.js') < html.indexOf('src="./options.js"'));
  assert.match(html, /id="options-recovery"[^>]*role="alert"/);
});


test('a failed connection locks pack submission while leaving its dialog close action available', () => {
  const f = fixture();f.expire();
  assert.equal(f.document.getElementById('rule-packs-add').inert, true);
  assert.notEqual(f.document.getElementById('rule-packs-dialog').inert, true);
  assert.notEqual(f.document.getElementById('rule-packs-close').inert, true);
});
