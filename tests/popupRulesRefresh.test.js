import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRulesViewSnapshot } from '../rules/rulesViewSnapshot.js';
import { getAssignmentUsageSeconds } from '../rules/ruleAssignments.js';
import { getLocalDateKey } from '../rules/dailyLimitManager.js';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
function member(opening, next) {
  const start = source.indexOf(`  ${opening}`);
  const end = source.indexOf(`\n  ${next}`, start + opening.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const rules = id => [{ id, blockURL: `rule${id}.example`, assignments: [
  { listId: 'general', blockingMode: 'always', disabledByUser: false }
] }];
const snapshot = id => ({ rules: rules(id), generation: `generation-${id}`, revisions: {} });
const lists = { lists: [{ id: 'general', disabledCategories: [] }], activeRuleListId: 'general' };
function element() {
  return { style: {}, dataset: {}, children: [], classList: { add() {} },
    appendChild(child) { this.children.push(child); }, addEventListener() {}, focus() {} };
}
function controller(deps = {}) {
  const defaults = {
    GENERAL_RULE_LIST_ID: 'general', MAX_RULES_LIMIT: 10,
    countFreeRules: rules => rules.length,
    getRuleAssignment: (rule, id) => rule.assignments.find(item => item.listId === id),
    getRuleAssignments: rule => rule.assignments, getAssignmentUsageSeconds,
    getRuleBlockingMode: () => 'always', BLOCKING_MODE_SCHEDULE: 'schedule', BLOCKING_MODE_DAILY_LIMIT: 'daily_limit',
    t: key => key, customAlert() {}, document: { createElement: element },
    configureUrlInput() {}, requestAnimationFrame() {},
    readRulesViewSnapshot: async () => ({ snapshot: await c.rulesManager.getRulesSnapshot(), ruleListState: lists, dailyUsageSeconds: {} }),
    ...deps
  };
  let c;
  const code = member('async loadRules(', 'showBlockThisSiteButton(') +
    member('createRuleInputs(', 'createSaveButton(');
  const C = new Function(...Object.keys(defaults), `return class Controller {${code}}`)(...Object.values(defaults));
  c = new C();
  Object.assign(c, { isPro: true, isLegacyUser: false, logger: { error() {} },
    ruleListsManager: { async getSnapshot() { return lists; } },
    dailyLimitManager: { async getUsageSeconds() { return {}; } },
    updateStatus() {}, showBlockThisSiteButton() {}, makeInputReadOnly() {} });
  return c;
}

test('a stale Popup snapshot cannot overwrite a newer completed rule refresh', async () => {
  let release;
  const old = new Promise(resolve => { release = resolve; });
  const rendered = [];
  const c = controller();
  let reads = 0;
  Object.assign(c, { rulesManager: { getRulesSnapshot() { return ++reads === 1 ? old : snapshot(2); } },
    rulesContainer: { innerHTML: '' }, createRuleInputs(_url, _redirect, id) { rendered.push(id); } });
  const pending = c.loadRules();
  await c.loadRules();
  release(snapshot(1));
  await pending;
  assert.deepEqual(rendered, [2]);
});

test('deferred Popup rows from a retired refresh cannot duplicate the current rules', async () => {
  const callbacks = [];
  const children = [];
  const c = controller({ setTimeout(fn) { callbacks.push(fn); } });
  let reads = 0;
  Object.assign(c, { rulesManager: { async getRulesSnapshot() { return snapshot(++reads); } },
    rulesContainer: {
      set innerHTML(_value) { children.length = 0; },
      insertAdjacentElement(_position, row) { children.push(row); }
    } });
  await c.loadRules();
  await c.loadRules();
  for (const callback of callbacks) callback();
  assert.deepEqual(children.map(row => row.dataset.ruleId), [2]);
});

function focusHarness() {
  const timers = [], frames = [], children = [];
  const document = { activeElement: {}, createElement() {
    const node = element();
    node.focus = () => { document.activeElement = node; };
    return node;
  } };
  const c = controller({ document, setTimeout(fn) { timers.push(fn); }, requestAnimationFrame(fn) { frames.push(fn); } });
  Object.assign(c, { rulesRefreshId: 1, activeDisabledCategories: [], currentRuleCount: 0, rulesContainer: { insertAdjacentElement(_position, row) {
    children.push(row); for (const child of row.children) child.isConnected = true;
  } }, createSaveButton() { return element(); } });
  return { c, document, timers, frames, children };
}

test('new Popup input focus is scheduled after insertion even when an earlier frame already ran', () => {
  const h = focusHarness(); h.c.createRuleInputs();
  assert.equal(h.frames.length, 0);
  h.timers.shift()();
  assert.equal(h.frames.length, 1);
  h.frames.shift()();
  assert.equal(h.document.activeElement, h.children[0].children[0]);
});

test('a late Popup frame never steals a manual focus choice or focuses a retired row', () => {
  for (const retire of [false, true]) {
    const h = focusHarness(); h.c.createRuleInputs(); h.timers.shift()();
    const chosen = h.document.activeElement = {};
    if (retire) h.c.rulesRefreshId++;
    h.frames.shift()();
    assert.equal(h.document.activeElement, chosen);
  }
  const h = focusHarness(); h.c.createRuleInputs(); h.c.rulesRefreshId++;
  h.timers.shift()(); assert.equal(h.children.length, 0); assert.equal(h.frames.length, 0);
});

test('rendering an existing Popup rule never schedules autofocus', () => {
  const h = focusHarness(); h.c.createRuleInputs('example.test', '', 1);
  h.timers.shift()(); assert.equal(h.frames.length, 0);
});

test('unchanged generation events preserve drafts and focus; a changed generation refreshes', () => {
  let handler; const chosen = {}; const document = { activeElement: chosen };
  const C = new Function('browser', `return class {${member('setupStorageListeners(', 'async loadStatisticsSummary(')}}`)(
    { storage: { onChanged: { addListener(fn) { handler = fn; } } } }
  );
  const c = new C(); let refreshes = 0;
  const draft = { value: 'typing.example' };
  c.loadRules = () => { refreshes++; draft.value = ''; document.activeElement = null; };
  c.setupStorageListeners();
  handler({ rulesGeneration: { oldValue: 'g1', newValue: 'g1' } }, 'local');
  assert.equal(refreshes, 0); assert.equal(draft.value, 'typing.example'); assert.equal(document.activeElement, chosen);
  handler({ rulesGeneration: { oldValue: 'g1', newValue: 'g2' } }, 'local');
  assert.equal(refreshes, 1);
});

test('every rendered Popup uses one assignment, list generation and projected remap budget snapshot', async () => {
  const now = new Date(2026, 9, 8, 12);
  const makeState = (id, generation, seconds) => ({
    rules: [{ id, blockURL: `rule${id}.example`, assignments: [{ listId: 'list-1', blockingMode: 'daily_limit', dailyLimit: { minutes: 2 } }] }],
    rulesGeneration: generation, ruleRevisions: { [id]: 3 },
    ruleLists: [{ id: 'list-1', name: 'Work', disabledCategories: [] }], activeRuleListId: 'list-1', ruleListRevisions: { 'list-1': 4 },
    dailyRuleUsage: { version: 2, date: getLocalDateKey(now), usageSeconds: { '1:general': seconds }, lastSample: null },
    pendingDailyUsageRemaps: [{ oldRuleId: 1, oldListId: 'general', newRuleId: id, newListId: 'list-1' }]
  });
  let state = makeState(2, 'g2', 65), reads = 0;
  const rendered = [];
  const c = controller({ readRulesViewSnapshot: () => readRulesViewSnapshot({ async get(keys) {
    reads++; assert.ok(keys.includes('pendingDailyUsageRemaps'));
    const committed = structuredClone(state);
    state = makeState(3, 'g3', 89); // import/move committed after the read captured its result
    return committed;
  } }, now) });
  Object.assign(c, { rulesContainer: { innerHTML: '' }, createRuleInputs(...args) {
    rendered.push({ id: args[2], list: args[7], minutes: args[9].minutes, used: args[10], generation: args[12], listGeneration: this.ruleListSnapshot.generation });
  } });
  await c.loadRules(); await c.loadRules();
  assert.equal(reads, 2);
  assert.deepEqual(rendered, [
    { id: 2, list: 'list-1', minutes: 2, used: 65, generation: 'g2', listGeneration: 'g2' },
    { id: 3, list: 'list-1', minutes: 2, used: 89, generation: 'g3', listGeneration: 'g3' }
  ]);
});


test('a Popup snapshot normalizes an expired day and journal without writing storage', async () => {
  const now = new Date(2026, 9, 8, 12);
  const raw = { rules: [], dailyRuleUsage: { version: 2, date: '2026-10-07', usageSeconds: { '1:general': 900 }, lastSample: { timestamp: now.getTime() - 86400000, assignmentKeys: ['1:general'] } },
    pendingDailyUsageRemaps: [{ oldRuleId: 1, oldListId: 'general', newRuleId: 2, newListId: 'general' }] };
  const before = structuredClone(raw);
  const result = await readRulesViewSnapshot({ async get() { return raw; }, async set() { assert.fail('reader must not persist'); } }, now);
  assert.deepEqual(result.dailyUsageSeconds, {});
  assert.deepEqual(raw, before);
});
