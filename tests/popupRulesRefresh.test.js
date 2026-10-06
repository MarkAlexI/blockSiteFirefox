import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
    getRuleAssignments: rule => rule.assignments, getAssignmentUsageSeconds: () => 0,
    getRuleBlockingMode: () => 'always', BLOCKING_MODE_SCHEDULE: 'schedule', BLOCKING_MODE_DAILY_LIMIT: 'daily_limit',
    t: key => key, customAlert() {}, document: { createElement: element },
    configureUrlInput() {}, requestAnimationFrame() {}, ...deps
  };
  const code = member('async loadRules(', 'showBlockThisSiteButton(') +
    member('createRuleInputs(', 'createSaveButton(');
  const C = new Function(...Object.keys(defaults), `return class Controller {${code}}`)(...Object.values(defaults));
  const c = new C();
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
