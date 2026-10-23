import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isVisibleRuleGroupEnd } from '../rules/visibleRuleGrouping.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
const item = (id = 52, listId = 'general', disabledByUser = false) => ({
  rule: { id, blockURL: `rule-${id}.example.test`, category: 'social', isWhitelist: false },
  assignment: { ...assignment, listId, disabledByUser }
});
const rowFor = (ui, value, onToggle = () => {}, muted = []) => ui.createRuleDisplayRow(
  value.rule, value.assignment, 0, () => {}, () => {}, onToggle, true, muted);

async function fixture(run) {
  const document = new FakeDocument();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    const { RulesUI } = await import('../rules/rulesUI.js');
    const ui = new RulesUI();
    try { await run({ document, ui }); } finally { ui.cleanup(); }
  }, { document });
}

test('manual rule toggles are native buttons with stable site-specific names and committed pressed states', () => fixture(({ ui }) => {
  const enabled = rowFor(ui, item()).querySelector('.rule-toggle');
  const disabled = rowFor(ui, item(52, 'general', true)).querySelector('.rule-toggle');
  for (const button of [enabled, disabled]) {
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('aria-label'), 'blockingmode_header: rule-52.example.test');
    assert.equal(button.disabled, false);
  }
  assert.equal(enabled.getAttribute('aria-pressed'), 'true');
  assert.equal(disabled.getAttribute('aria-pressed'), 'false');
  assert.equal(enabled.textContent, '✓');
  assert.equal(disabled.textContent, '✗');
}));

test('muted categories expose an unavailable native toggle and cannot issue a mutation', () => fixture(async ({ ui }) => {
  let calls = 0;
  const button = rowFor(ui, item(), () => { calls++; }, ['social']).querySelector('.rule-toggle');
  assert.equal(button.disabled, true);
  await button.dispatch('click');
  assert.equal(calls, 0);
}));

test('pending authorization or mutation ignores duplicate activation without changing the displayed state', () => fixture(async ({ document, ui }) => {
  let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const row = rowFor(ui, item(), async () => { calls++; await waiting; });
  document.body.appendChild(row);
  const button = row.querySelector('.rule-toggle');
  button.focus();
  const first = button.dispatch('click');
  await button.dispatch('click');
  assert.equal(calls, 1);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.disabled, false, 'waiting must not remove keyboard focus');
  assert.equal(document.activeElement, button);
  release(false);
  await first;
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'cancel is not an optimistic commit');
  await button.dispatch('click');
  assert.equal(calls, 2, 'an explicit later activation remains possible');
}));

test('a rejected rule mutation releases the toggle without inventing a new saved state', () => fixture(async ({ ui }) => {
  let calls = 0;
  ui.logger.error = () => {};
  const button = rowFor(ui, item(), async () => { calls++; throw new Error('fixture rejection'); }).querySelector('.rule-toggle');
  await button.dispatch('click');
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  await button.dispatch('click');
  assert.equal(calls, 2);
}));

function controller(document, ui) {
  const source = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
  const start = source.indexOf('  renderRules(');
  const end = source.indexOf('\n  createRuleRow(', start);
  assert.ok(start >= 0 && end > start);
  const Controller = new Function('document', 't', 'isVisibleRuleGroupEnd',
    `return class RenderRules {${source.slice(start, end)}};`)(document, key => key, isVisibleRuleGroupEnd);
  const c = new Controller();
  c.rulesBody = document.addElement('rules-container', 'tbody');
  c.addRuleButton = document.addElement('add-rule', 'button');
  c.rulesUI = ui;
  c.createRuleRow = (value, _index, _canEdit, muted) => rowFor(ui, value, () => {}, muted);
  return c;
}

test('table refresh keeps focus on the same rule assignment across ordering and saved-state changes', () => fixture(({ document, ui }) => {
  const c = controller(document, ui);
  c.renderRules([item(51), item(52)], true);
  const old = c.rulesBody.children[0].querySelector('.rule-toggle');
  old.focus();
  c.renderRules([item(52, 'general', true), item(51)], true);
  const replacement = c.rulesBody.children[1].querySelector('.rule-toggle');
  assert.notEqual(replacement, old);
  assert.equal(document.activeElement, replacement);
  assert.equal(replacement.getAttribute('aria-pressed'), 'false');
}));

test('a refresh does not take focus from another control after a delayed mutation', () => fixture(({ document, ui }) => {
  const c = controller(document, ui);
  c.renderRules([item()], true);
  c.rulesBody.children[0].querySelector('.rule-toggle').focus();
  const search = document.addElement('search-input', 'input');
  search.focus();
  c.renderRules([item(52, 'general', true)], true);
  assert.equal(document.activeElement, search);
  assert.equal(c.rulesBody.children[0].querySelector('.rule-toggle').focusCount, 0);
}));

for (const [label, next, muted] of [
  ['removed rule', [], []], ['another list assignment', [item(52, 'work')], []],
  ['muted category', [item()], ['social']]
]) {
  test(`a focused toggle falls back to Add after ${label}`, () => fixture(({ document, ui }) => {
    const c = controller(document, ui);
    c.renderRules([item()], true);
    c.rulesBody.children[0].querySelector('.rule-toggle').focus();
    c.renderRules(next, true, false, muted);
    assert.equal(document.activeElement, c.addRuleButton);
  }));
}
