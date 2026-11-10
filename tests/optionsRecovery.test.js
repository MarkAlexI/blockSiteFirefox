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

function fixture({ brokenI18n = false, storage = new Map(), storageDenied = false, clipboardDenied = false } = {}) {
  const document = new FakeDocument(), timers = new Map();
  const ids = ['options-recovery', 'options-recovery-message', 'options-recovery-reload',
    'options-recovery-copy', 'options-recovery-report', 'options-recovery-status', 'rules-loading-message',
    'quick-add-rule', 'add-rule', 'add-whitelist-rule', 'open-rule-packs', 'rule-packs-dialog',
    'rule-packs-add', 'rule-packs-close', 'rule-lists-panel', 'categories-container', 'rules-table', 'rules-management-panel'];
  for (const id of ids) document.addElement(id);
  const banner = document.getElementById('options-recovery');banner.hidden = true;
  const paid = document.getElementById('add-whitelist-rule');paid.disabled = true;
  const dialog = document.getElementById('categories-container');dialog.inert = true;
  let serial = 0, reloads = 0;
  const copied = [], storageWrites = [];
  const window = { location: { protocol: 'chrome-extension:', reload() { reloads++; } }, addEventListener() {},
    localStorage: {
      getItem(key) { if (storageDenied) throw new Error('Denied');return storage.get(key) ?? null; },
      setItem(key, value) { if (storageDenied) throw new Error('Denied');storageWrites.push(key);storage.set(key, value); },
      removeItem(key) { storage.delete(key); }
    }
  };
  const context = vm.createContext({ document, window,
    navigator: { userAgent: 'Chrome/124.0 Android 12', clipboard: { async writeText(text) {
      if (clipboardDenied) throw new Error('Denied');copied.push(text);
    } } },
    URL,
    chrome: { runtime: { getManifest: () => ({ version: '5.6.5' }),
      getURL: path => `chrome-extension://private-extension-id/${path}` },
      i18n: { getMessage(key) { if (brokenI18n) throw new Error('Extension context invalidated.'); return key; } } },
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
    storage, storageWrites, copied,
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

test('a stalled usage read is identified separately from healthy rule reads and messaging', async () => {
  const f = fixture();
  f.page.dailyLimitManager.getUsageSeconds = () => new Promise(() => {});
  void f.page.refreshProfileView();await settle();f.expire();
  const failure = f.guard.getReport().lastFailure;
  assert.equal(failure.reason, 'deadline');
  assert.equal(failure.stages.usage.state, 'pending');
  for (const stage of ['rules', 'lists', 'connection']) assert.equal(failure.stages[stage].state, 'ok');
  assert.equal(failure.stages.render.state, 'idle');
});

test('failed module startup is identifiable without importing the Options module', () => {
  const f = fixture();f.expire();
  assert.equal(f.guard.getReport().lastFailure.stages.module.state, 'pending');
});

test('the local failure survives a new page and successful reads, and can be cleared', async () => {
  const broken = fixture();
  broken.context.checkRulesConnection = async () => { throw new Error('Receiving end does not exist.'); };
  await broken.page.refreshProfileView();
  const failure = JSON.stringify(broken.guard.getReport().lastFailure);
  const restored = fixture({ storage: broken.storage });await restored.page.refreshProfileView();
  assert.equal(restored.guard.state, 'ready');
  assert.equal(JSON.stringify(restored.guard.getReport().lastFailure), failure);
  assert.equal(restored.guard.getReport().lastFailure.stages.connection.code, 'no_receiver');
  assert.deepEqual(broken.storageWrites, ['bdOptionsRecoveryFailureV1']);
  restored.guard.clearFailure();
  assert.equal(restored.guard.getReport().lastFailure, null);
  assert.equal(restored.storage.size, 0);
});

test('copying recovery details works without background requests and excludes raw sensitive errors', async () => {
  const f = fixture({ brokenI18n: true });
  f.page.rulesManager.getRulesSnapshot = async () => { throw new Error('Extension context invalidated. secret@example.com https://private.example BD-LICENSE-SECRET'); };
  await f.page.refreshProfileView();
  await f.document.getElementById('options-recovery-copy').click();
  assert.equal(f.copied.length, 1);
  assert.equal(JSON.parse(f.copied[0]).lastFailure.stages.rules.code, 'context_invalidated');
  assert.doesNotMatch(f.copied[0], /secret@example|private\.example|BD-LICENSE|private-extension-id/);
  assert.equal(f.document.getElementById('options-recovery-status').textContent, 'Diagnostic report copied.');
});

test('denied storage and clipboard leave recovery details available for manual copying', async () => {
  const f = fixture({ storageDenied: true, clipboardDenied: true });f.expire();
  await f.document.getElementById('options-recovery-copy').click();
  const output = f.document.getElementById('options-recovery-report');
  assert.equal(output.hidden, false);
  assert.equal(JSON.parse(output.value).current.state, 'failed');
  assert.equal(f.copied.length, 0);
  assert.notEqual(f.document.getElementById('options-recovery-status').textContent, 'diagnosticscopied');
  assert.equal(f.reloads, 0);
});

test('only the current refresh can change diagnostic stages', async () => {
  const f = fixture(), read = deferred();let count = 0;
  const current = f.page.rulesManager.getRulesSnapshot;
  f.page.rulesManager.getRulesSnapshot = () => ++count === 1 ? read.promise : current();
  const old = f.page.refreshProfileView();await settle();
  await f.page.refreshProfileView();
  read.reject(new Error('Extension context invalidated'));await old;
  assert.equal(f.guard.getReport().current.stages.rules.state, 'ok');
  assert.equal(f.guard.getReport().lastFailure, null);
});

test('persisted reports are schema limited rather than trusting local storage text', async () => {
  const f = fixture();f.expire();
  const key = 'bdOptionsRecoveryFailureV1';
  const value = JSON.parse(f.storage.get(key));
  value.secret = 'secret@example.com';value.stages.rules.code = 'https://private.example';
  value.environment.pageScheme = 'private-scheme:';value.stages.foreign = { state: 'ok' };
  f.storage.set(key, JSON.stringify(value));
  const restored = fixture({ storage: f.storage });
  const report = JSON.stringify(restored.guard.getReport());
  assert.doesNotMatch(report, /secret@example|private\.example|private-scheme|foreign/);
  assert.equal(restored.guard.getReport().lastFailure.environment.pageScheme, 'unknown');
});

test('the independent report identifies the actual packaged page build', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(fixture().guard.getReport().current.pageVersion, manifest.version);
});

test('oversized and malformed saved reports do not prevent loading or enter copied diagnostics', async () => {
  for (const value of ['{invalid', JSON.stringify({ schemaVersion: 2 }), 'x'.repeat(8193)]) {
    const f = fixture({ storage: new Map([['bdOptionsRecoveryFailureV1', value]]) });
    await f.page.refreshProfileView();
    assert.equal(f.guard.state, 'ready');
    assert.equal(f.guard.getReport().lastFailure, null);
  }
});

test('a render exception is distinguished from failed storage reads', async () => {
  const f = fixture();
  f.page.renderRules = () => { throw new Error('rendering failed with private.example'); };
  await f.page.refreshProfileView();
  const failure = f.guard.getReport().lastFailure;
  assert.equal(failure.reason, 'error');
  assert.equal(failure.stages.render.state, 'error');
  for (const stage of ['rules', 'lists', 'usage', 'connection']) assert.equal(failure.stages[stage].state, 'ok');
  assert.doesNotMatch(JSON.stringify(failure), /private\.example/);
});
