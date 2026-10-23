import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument, FakeElement } from './helpers/extensionTestHarness.js';
import { configureUrlInput } from '../dom/urlInput.js';
import { countFreeRules, getRuleAssignment, getRuleAssignments, getAssignmentUsageSeconds } from '../rules/ruleAssignments.js';
import { getRuleBlockingMode, normalizeDailyLimit, BLOCKING_MODE_SCHEDULE, BLOCKING_MODE_DAILY_LIMIT } from '../rules/blockingMode.js';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
function member(opening, next) {
  const start = source.indexOf(`  ${opening}`);
  const end = source.indexOf(`\n  ${next}`, start + opening.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const rule = (id = 54, listId = 'general', disabledByUser = false) => ({
  id, blockURL: `rule-${id}.example.test`, redirectURL: '', category: 'social', isWhitelist: false,
  assignments: [{ listId, disabledByUser, blockingMode: 'always', schedule: null, dailyLimit: null }]
});

function fixture() {
  const document = new FakeDocument();
  document.activeElement = document.body;
  const rows = document.addElement('rules-container');
  // Model the browser's focus loss on removal; FakeElement does not simulate it.
  Object.defineProperty(rows, 'innerHTML', { set(value) {
    const removedFocus = this.querySelectorAll('*').includes(document.activeElement);
    Object.getOwnPropertyDescriptor(FakeElement.prototype, 'innerHTML').set.call(this, value);
    if (removedFocus) document.activeElement = document.body;
  } });
  rows.insertAdjacentElement = (_position, row) => {
    rows.children.unshift(row); row.parentNode = rows;
  };
  const timers = [], frames = [], calls = [], errors = [];
  let state = { rules: [rule()], active: 'general', muted: [] }, read;
  const dependencies = {
    document, configureUrlInput, countFreeRules, getRuleAssignment, getRuleAssignments,
    getAssignmentUsageSeconds, getRuleBlockingMode, normalizeDailyLimit,
    BLOCKING_MODE_SCHEDULE, BLOCKING_MODE_DAILY_LIMIT, GENERAL_RULE_LIST_ID: 'general', MAX_RULES_LIMIT: 10,
    formatDailyLimitUsageMinutes: (seconds, minutes) => String(Math.min(minutes, seconds / 60)),
    t: key => key, customAlert: message => errors.push(message),
    setTimeout: fn => { timers.push(fn); }, requestAnimationFrame: fn => { frames.push(fn); },
    readRulesViewSnapshot: async () => {
      if (read) return read();
      return {
        snapshot: { rules: structuredClone(state.rules), generation: 'shown-generation', revisions: { 54: 7 } },
        ruleListState: { lists: [{ id: 'general', disabledCategories: state.muted }, { id: 'work', disabledCategories: [] }],
          activeRuleListId: state.active }, dailyUsageSeconds: {}
      };
    }
  };
  const code = member('async loadRules(', 'showBlockThisSiteButton(') +
    member('createRuleInputs(', 'createSaveButton(') +
    member('toggleUIAccessibility(', 'async updateFocusUI(') +
    member('async handleRuleToggle(', 'handleRulesMutationError(') +
    member('makeInputReadOnly(', 'updateStatus(');
  const C = new Function(...Object.keys(dependencies), `return class PopupControls {${code}}`)(...Object.values(dependencies));
  const c = new C();
  Object.assign(c, {
    rulesContainer: rows, addRuleButton: document.addElement('add-rule', 'button'),
    activeDisabledCategories: [], isPro: true, isLegacyUser: false, currentRuleCount: 1,
    activeRuleListId: 'general', rulesRefreshId: 1,
    ruleLists: [{ id: 'general' }, { id: 'work', name: 'Work' }],
    ruleListSnapshot: { generation: 'shown-generation', revisions: {} },
    logger: { error: (...args) => errors.push(args) },
    scheduleFormatter: { formatSchedule: () => 'Scheduled' },
    async authorizePasswordProtectedRuleChange() { return true; },
    rulesClient: { async toggleRule(...args) { calls.push(args); } },
    updateStatus() {}, showBlockThisSiteButton() {}, showRulesMutationResult() {},
    createSaveButton() { return document.createElement('button'); },
    logRulesMutationFailure() {}, handleRulesMutationError: error => errors.push(error)
  });
  const flush = () => { while (timers.length) timers.shift()(); while (frames.length) frames.shift()(); };
  const render = value => {
    const a = value.assignments[0];
    c.createRuleInputs(value.blockURL, '', value.id, a.disabledByUser, value.category,
      a.schedule, value.isWhitelist, a.listId, a.blockingMode, a.dailyLimit, 0,
      value.assignments, 'shown-generation', 7);
    flush();
    return rows.children[0];
  };
  return { c, document, rows, calls, errors, timers, flush, render,
    state: value => { state = value; }, read: fn => { read = fn; } };
}

test('Popup manual toggles are named native buttons with committed pressed states', () => {
  const f = fixture();
  for (const disabled of [false, true]) {
    const button = f.render(rule(54, 'general', disabled)).querySelector('.rule-toggle-popup');
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('aria-label'), 'blockingmode_header: rule-54.example.test');
    assert.equal(button.getAttribute('aria-pressed'), String(!disabled));
    assert.equal(button.textContent, disabled ? '✗' : '✓');
  }
});

test('Popup muted-category toggles are unavailable and cannot request a change', async () => {
  const f = fixture(); f.c.activeDisabledCategories = ['social'];
  const button = f.render(rule()).querySelector('.rule-toggle-popup');
  assert.equal(button.disabled, true);
  await button.dispatch('click');
  assert.equal(f.calls.length, 0);
});

test('Popup pending authorization retains focus, ignores duplicate activation and does not change saved state', async () => {
  const f = fixture(); let release, authorizations = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.c.authorizePasswordProtectedRuleChange = () => { authorizations++; return gate; };
  const button = f.render(rule()).querySelector('.rule-toggle-popup'); button.focus();
  const first = button.dispatch('click'), duplicate = button.dispatch('click');
  try {
    assert.equal(authorizations, 1);
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(f.document.activeElement, button);
  } finally { release(false); await Promise.all([first, duplicate]); }
  assert.notEqual(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(f.calls.length, 0);
  await button.dispatch('click'); assert.equal(authorizations, 2);
});

test('Popup delayed authorization sends the displayed assignment and revision after the active list changes', async () => {
  const f = fixture(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.c.authorizePasswordProtectedRuleChange = () => gate;
  const button = f.render(rule(54, 'work')).querySelector('.rule-toggle-popup');
  const first = button.dispatch('click');
  f.c.activeRuleListId = 'general'; f.c.ruleListSnapshot = { generation: 'new', revisions: {} };
  release(true); await first;
  assert.deepEqual(f.calls, [[54, 'work', 'shown-generation', 7]]);
});

test('Popup failed mutations release the guard without inventing a pressed-state change', async () => {
  const f = fixture(); let calls = 0;
  f.c.rulesClient.toggleRule = async () => { calls++; throw new Error('fixture rejection'); };
  const button = f.render(rule()).querySelector('.rule-toggle-popup');
  await button.dispatch('click'); await button.dispatch('click');
  assert.equal(calls, 2);
  assert.notEqual(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('Popup replacement rows retain the focused rule assignment across reordering and saved-state changes', async () => {
  const f = fixture(); const old = f.render(rule()).querySelector('.rule-toggle-popup'); old.focus();
  f.state({ rules: [rule(55), rule(54, 'general', true)], active: 'general', muted: [] });
  await f.c.loadRules(); f.flush();
  const replacement = f.rows.children.find(row => String(row.dataset.ruleId) === '54').querySelector('.rule-toggle-popup');
  assert.notEqual(replacement, old);
  assert.equal(f.document.activeElement, replacement);
  assert.equal(replacement.getAttribute('aria-pressed'), 'false');
});

for (const when of ['during read', 'after removal']) {
  test(`Popup refresh respects a manual focus choice ${when}`, async () => {
    const f = fixture(); f.render(rule()).querySelector('.rule-toggle-popup').focus();
    if (when === 'during read') {
      let release; const gate = new Promise(resolve => { release = resolve; });
      f.read(() => gate); const pending = f.c.loadRules(); f.c.addRuleButton.focus();
      release({ snapshot: { rules: [rule()], generation: 'new', revisions: {} },
        ruleListState: { lists: [{ id: 'general', disabledCategories: [] }], activeRuleListId: 'general' }, dailyUsageSeconds: {} });
      await pending;
    } else { await f.c.loadRules(); f.c.addRuleButton.focus(); }
    f.flush(); assert.equal(f.document.activeElement, f.c.addRuleButton);
  });
}

test('Popup overlapping refreshes retain the focus intent until the current row is inserted', async () => {
  const f = fixture(); f.render(rule()).querySelector('.rule-toggle-popup').focus();
  await f.c.loadRules();
  f.state({ rules: [rule(54, 'general', true)], active: 'general', muted: [] });
  await f.c.loadRules(); f.flush();
  const button = f.rows.querySelector('.rule-toggle-popup');
  assert.equal(f.rows.children.length, 1);
  assert.equal(f.document.activeElement, button);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});

for (const [label, next] of [
  ['removed rule', { rules: [], active: 'general', muted: [] }],
  ['different list', { rules: [rule(54, 'work')], active: 'work', muted: [] }],
  ['muted category', { rules: [rule()], active: 'general', muted: ['social'] }],
  ['static Daily Limit', { rules: [{ ...rule(), assignments: [{ ...rule().assignments[0], blockingMode: 'daily_limit', dailyLimit: { minutes: 2 } }] }], active: 'general', muted: [] }]
]) {
  test(`Popup focused toggle falls back to Add after ${label}`, async () => {
    const f = fixture(); f.render(rule()).querySelector('.rule-toggle-popup').focus();
    f.state(next); await f.c.loadRules(); f.flush();
    assert.equal(f.document.activeElement, f.c.addRuleButton);
  });
}

test('Popup focus-session lock disables manual toggles and preserves category unavailability after unlock', async () => {
  const f = fixture(); const button = f.render(rule()).querySelector('.rule-toggle-popup');
  f.c.toggleUIAccessibility(true);
  assert.equal(button.disabled, true);
  await button.dispatch('click'); assert.equal(f.calls.length, 0);
  const addedWhileLocked = f.render(rule(55)).querySelector('.rule-toggle-popup');
  assert.equal(addedWhileLocked.disabled, true);
  f.c.activeDisabledCategories = ['social'];
  const muted = f.render(rule(56)).querySelector('.rule-toggle-popup');
  f.c.toggleUIAccessibility(false);
  assert.equal(button.disabled, false);
  assert.equal(addedWhileLocked.disabled, false);
  assert.equal(muted.disabled, true);
});

test('Popup whitelist, schedule and Daily Limit statuses never become manual toggles', () => {
  const f = fixture();
  for (const value of [
    { ...rule(), isWhitelist: true },
    { ...rule(), assignments: [{ ...rule().assignments[0], blockingMode: 'schedule', schedule: { enabled: true } }] },
    { ...rule(), assignments: [{ ...rule().assignments[0], blockingMode: 'daily_limit', dailyLimit: { minutes: 2 } }] }
  ]) assert.equal(f.render(value).querySelector('.rule-toggle-popup'), null);
});


test('Popup URL fields keep localized names and unchanged values after placeholders are cleared', () => {
  const f = fixture();
  for (const value of [rule(), { ...rule(), isWhitelist: true }, { ...rule(), id: null, blockURL: '' }]) {
    const row = f.render(value), inputs = row.querySelectorAll('input');
    assert.equal(inputs[0].getAttribute('aria-label'), 'blockurl');
    assert.equal(inputs[1].getAttribute('aria-label'), 'redirecturl');
    assert.equal(inputs[0].value, value.blockURL);
    if (value.id) assert.equal(inputs[0].placeholder, '', 'name survives the readonly renderer');
  }
});
