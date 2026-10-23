import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
import { RuleEditorFeedback } from '../rules/ruleEditorFeedback.js';
import { configureUrlInput } from '../dom/urlInput.js';
import { getRulesMutationFeedback } from '../rules/rulesMutationFeedback.js';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
function member(opening, next) {
  const start = source.indexOf(`  ${opening}`), end = source.indexOf(`\n  ${next}`, start + opening.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const code = member('createRuleInputs(', 'createSaveButton(') + member('createSaveButton(', 'async initFocusSession(') +
  member('handleRulesMutationError(', 'async saveNewRule(') + member('async saveNewRule(', 'async handleRuleDeletion(') +
  member('showRulesMutationResult(', 'async promptForPassword(');

async function popupTest(run) {
  const document = new FakeDocument(); document.activeElement = document.body;
  await withExtensionEnvironment(createExtensionApi(), async () => {
    const { RulesUI } = await import('../rules/rulesUI.js');
    const ui = new RulesUI(), notices = [], writes = [], timers = [];
    ui.showAlert = message => notices.push(message);
    const dependencies = { document, RuleEditorFeedback, configureUrlInput, getRulesMutationFeedback,
      GENERAL_RULE_LIST_ID: 'general', MAX_RULES_LIMIT: 10, countFreeRules: rules => rules.length,
      t: key => key, customAlert: message => notices.push(message),
      setTimeout: fn => timers.push(fn), requestAnimationFrame: fn => timers.push(fn) };
    const C = new Function(...Object.keys(dependencies), `return class PopupEditor {${code}}`)(...Object.values(dependencies));
    const c = new C(), rows = document.addElement('rules-container');
    rows.insertAdjacentElement = (_position, row) => { rows.children.unshift(row); row.parentNode = rows; };
    Object.assign(c, { rulesUI: ui, rulesContainer: rows, rulesRefreshId: 1, activeDisabledCategories: [],
      isPro: true, isLegacyUser: false, activeRuleListId: 'work', currentRuleCount: 0,
      ruleListSnapshot: { generation: 'shown', revisions: { work: 'shown-work' } },
      addRuleButton: document.addElement('add-rule', 'button'),
      addWhitelistRuleButton: document.addElement('add-whitelist-rule', 'button'),
      rulesManager: { async getRules() { return []; } },
      rulesClient: { async addRule(payload) { writes.push(payload); return { success: true }; } },
      logRulesMutationFailure() {}, async loadRules() {}, logger: { info() {}, error() {} } });
    const make = (whitelist = false) => {
      c.createRuleInputs('', '', null, false, whitelist ? 'whitelist' : 'uncategorized', null, whitelist);
      while (timers.length) timers.shift()();
      const row = rows.children[0], inputs = row.querySelectorAll('input');
      return { row, block: inputs[0], redirect: inputs[1], save: row.querySelector('.save-btn') };
    };
    await run({ c, document, ui, rows, notices, writes, make });
  }, { document });
}
const error = (code, validationErrors) => Object.assign(new Error(code), { code, validationErrors });
const rejectWith = (c, failure) => { c.rulesClient.addRule = async () => { throw failure; }; };

test('a new Popup draft has no premature invalid fields or error content', () => popupTest(({ make }) => {
  const f = make();
  assert.equal(f.block.getAttribute('aria-invalid'), null);
  assert.equal(f.redirect.getAttribute('aria-describedby'), null);
  assert.equal(f.row.querySelector('.rule-field-error'), null);
}));

test('Popup validation retains both values and describes and focuses the first invalid field', () => popupTest(async ({ c, document, make, notices }) => {
  const f = make(); f.redirect.value = 'ftp://draft.example';
  rejectWith(c, error('validation_failed', ['redirect_invalid', 'blockurl_empty']));
  f.save.focus(); await f.save.dispatch('click');
  assert.equal(f.block.getAttribute('aria-invalid'), 'true');
  assert.equal(f.redirect.getAttribute('aria-invalid'), 'true');
  assert.equal(document.activeElement, f.block);
  assert.equal(f.redirect.value, 'ftp://draft.example');
  const id = f.redirect.getAttribute('aria-describedby');
  assert.equal(document.getElementById(id).textContent, 'wrongredirecturl - redirecturlhint');
  assert.deepEqual(notices, [], 'focused descriptions do not also enqueue a notice');
  assert.equal(f.row.querySelectorAll('tr, td').length, 0, 'Popup feedback uses valid non-table markup');
  const links = f.row.querySelectorAll('.rule-field-error a');
  assert.equal(links.length, 2); await links[0].dispatch('click'); assert.equal(document.activeElement, f.redirect);
}));

for (const code of ['rule_already_exists', 'conflict_blacklist', 'conflict_whitelist', 'redundant_whitelist']) {
  test(`Popup ${code} preserves the draft and associates the problem with the blocked address`, () => popupTest(async ({ c, document, make }) => {
    const f = make(); f.block.value = 'retained.example'; f.redirect.value = 'https://redirect.example/';
    rejectWith(c, error(code)); f.save.focus(); await f.save.dispatch('click');
    assert.equal(f.block.value, 'retained.example'); assert.equal(f.redirect.value, 'https://redirect.example/');
    assert.equal(f.block.getAttribute('aria-invalid'), 'true'); assert.equal(document.activeElement, f.block);
    const text = document.getElementById(f.block.getAttribute('aria-describedby')).textContent;
    assert.ok(text); assert.notEqual(text, code, 'feedback is localized rather than a raw error code');
  }));
}

test('correcting one Popup field clears its error and preserves unrelated help and the other error', () => popupTest(async ({ c, document, make }) => {
  const f = make(); f.block.setAttribute('aria-describedby', 'existing-help');
  rejectWith(c, error('validation_failed', ['blockurl_empty', 'redirect_invalid']));
  f.save.focus(); await f.save.dispatch('click');
  const id = f.block.getAttribute('aria-describedby').split(' ')[1];
  f.block.value = 'corrected.example'; await f.block.dispatch('input');
  assert.equal(f.block.getAttribute('aria-describedby'), 'existing-help'); assert.equal(document.getElementById(id), null);
  assert.equal(f.block.getAttribute('aria-invalid'), null); assert.equal(f.redirect.getAttribute('aria-invalid'), 'true');
}));

test('Popup pending guard starts before a Free rules read and preserves the displayed destination', () => popupTest(async ({ c, make, writes }) => {
  c.isPro = false; let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  c.rulesManager.getRules = () => { reads++; return gate; };
  const f = make(); f.block.value = 'once.example'; f.save.focus();
  const first = f.save.dispatch('click'), duplicate = f.save.dispatch('click');
  try {
    assert.equal(reads, 1); assert.equal(f.row.getAttribute('aria-busy'), 'true');
    assert.equal(f.save.getAttribute('aria-disabled'), 'true'); assert.equal(f.save.disabled, false); assert.equal(f.block.disabled, true);
    c.activeRuleListId = 'elsewhere';
  } finally { release([]); await Promise.all([first, duplicate]); }
  assert.equal(writes.length, 1); assert.equal(writes[0].assignment.listId, 'general');
  assert.equal(writes[0].expectedGeneration, 'shown'); assert.deepEqual(writes[0].expectedListRevisions, { work: 'shown-work' });
}));

test('a pending Popup write ignores duplicate Save and restores the whitelist control states after rejection', () => popupTest(async ({ c, document, make }) => {
  let release, writes = 0;
  const gate = new Promise((_resolve, reject) => { release = reject; });
  c.rulesClient.addRule = () => { writes++; return gate; };
  const f = make(true); f.block.value = 'allowed.example'; f.save.focus();
  const first = f.save.dispatch('click'), duplicate = f.save.dispatch('click');
  try { assert.equal(writes, 1); assert.equal(document.activeElement, f.save); assert.equal(f.block.disabled, true); }
  finally { release(error('validation_failed', ['blockurl_invalid'])); await Promise.all([first, duplicate]); }
  assert.equal(f.redirect.disabled, true); assert.equal(f.block.disabled, false);
  assert.equal(f.row.getAttribute('aria-busy'), null); assert.equal(f.save.getAttribute('aria-disabled'), null);
}));

test('Popup committed pending synchronization returns focus to Add and dispatches once', () => popupTest(async ({ c, document, make, notices, writes }) => {
  c.rulesClient.addRule = async payload => { writes.push(payload); return { success: true, syncPending: true }; };
  const f = make(); f.block.value = 'saved.example'; f.save.focus(); await f.save.dispatch('click');
  assert.equal(f.row.parentNode, null); assert.equal(writes.length, 1); assert.equal(document.activeElement, c.addRuleButton);
  assert.deepEqual(notices, ['ruleschangessavedpending']);
}));

test('successful Popup whitelist Save returns focus to Add Whitelist and sends the captured General context', () => popupTest(async ({ c, document, make, writes }) => {
  const f = make(true); f.block.value = 'allowed.example'; f.save.focus(); await f.save.dispatch('click');
  assert.equal(document.activeElement, c.addWhitelistRuleButton);
  assert.equal(writes[0].isWhitelist, true); assert.equal(writes[0].assignment.listId, 'general'); assert.equal(writes[0].redirectURL, '');
}));

for (const failed of [false, true]) {
  test(`a delayed Popup ${failed ? 'field error' : 'success'} respects a later keyboard focus choice`, () => popupTest(async ({ c, document, make, notices }) => {
    let release;
    c.rulesClient.addRule = () => new Promise((resolve, reject) => { release = () => failed ? reject(error('validation_failed', ['redirect_invalid'])) : resolve({ success: true }); });
    const f = make(); f.block.value = 'draft.example'; f.save.focus(); const first = f.save.dispatch('click');
    const other = document.addElement('other', 'button'); other.focus(); await document.dispatch('focusin', { target: other });
    release(); await first; assert.equal(document.activeElement, other);
    if (failed) { assert.equal(f.redirect.getAttribute('aria-invalid'), 'true'); assert.deepEqual(notices, ['wrongredirecturl - redirecturlhint']); }
  }));
}

test('independent Popup drafts keep distinct error descriptions', () => popupTest(async ({ c, make }) => {
  rejectWith(c, error('validation_failed', ['redirect_invalid']));
  const a = make(), b = make(); a.save.focus(); await a.save.dispatch('click'); b.save.focus(); await b.save.dispatch('click');
  assert.ok(a.redirect.getAttribute('aria-describedby'));
  assert.notEqual(a.redirect.getAttribute('aria-describedby'), b.redirect.getAttribute('aria-describedby'));
}));

test('Popup unexpected write failures retain the draft, release the guard and show a safe retryable notice', () => popupTest(async ({ c, make, notices }) => {
  const f = make(); f.block.value = 'retry.example'; rejectWith(c, error('private-error'));
  f.save.focus(); await f.save.dispatch('click');
  assert.equal(f.block.value, 'retry.example'); assert.equal(f.block.disabled, false); assert.equal(f.save.getAttribute('aria-disabled'), null);
  assert.deepEqual(notices, ['erroraddingrule']);
  c.rulesClient.addRule = async () => ({ success: true }); await f.save.dispatch('click'); assert.equal(f.row.parentNode, null);
}));
