import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

async function editorTest(run) {
  const document = new FakeDocument(), tasks = new Map(), nativeAlerts = [];
  document.defaultView = new FakeDocument();
  let nextId = 0;
  const originals = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, alert: globalThis.alert };
  globalThis.setTimeout = (callback, delay) => { tasks.set(++nextId, { callback, delay }); return nextId; };
  globalThis.clearTimeout = id => tasks.delete(id);
  globalThis.alert = message => nativeAlerts.push(message);
  try {
    await withExtensionEnvironment(createExtensionApi(), async () => {
      const { RulesUI } = await import('../rules/rulesUI.js');
      const ui = new RulesUI();
      const notices = [];
      ui.showAlert = message => notices.push(message);
      const make = save => {
        const row = ui.createAddRuleRow(save, row => row.remove(), true);
        document.body.appendChild(row);
        return { row, save: row.querySelector('.save-btn'), block: row.children[0].querySelector('input'),
          redirect: row.children[1].querySelector('input'), mode: row.querySelector('.blocking-mode-select'),
          daily: row.querySelector('.daily-limit-minutes') };
      };
      await run({ document, ui, make, tasks, notices, nativeAlerts });
    }, { document });
  } finally {
    await document.defaultView.dispatch('pagehide');
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}

test('validation is associated with each invalid field and focuses the first field after Save', () => editorTest(async ({ document, ui, make, notices }) => {
  let row;
  const form = make(() => ui.showValidationErrors(['redirect_invalid', 'blockurl_empty'], row));
  row = form.row;
  form.redirect.value = 'ftp://redirect.example';
  form.save.focus();
  await form.save.dispatch('click');
  assert.equal(form.block.getAttribute('aria-invalid'), 'true');
  assert.equal(form.redirect.getAttribute('aria-invalid'), 'true');
  const error = document.getElementById(form.redirect.getAttribute('aria-describedby'));
  assert.equal(error.textContent, 'wrongredirecturl - redirecturlhint');
  assert.equal(error.getAttribute('role'), null, 'the focused field description is not also a live alert');
  assert.equal(document.activeElement, form.block);
  assert.equal(form.redirect.value, 'ftp://redirect.example');
  assert.deepEqual(notices, [], 'focused validation does not enqueue a duplicate announcement');
}));

test('invalid Daily Limit shows persistent field feedback and sends no mutation', () => editorTest(async ({ document, make, notices }) => {
  let writes = 0;
  const form = make(() => writes++);
  form.mode.value = 'daily_limit'; await form.mode.dispatch('change');
  form.daily.value = '0'; form.block.value = 'draft.example';
  form.save.focus(); await form.save.dispatch('click');
  assert.equal(writes, 0);
  assert.equal(form.daily.getAttribute('aria-invalid'), 'true');
  assert.equal(document.activeElement, form.daily);
  assert.equal(form.block.value, 'draft.example');
  assert.deepEqual(notices, []);
}));

test('pending Save prevents duplicate writes and restores the prior control states after failure', () => editorTest(async ({ ui, make }) => {
  let release, writes = 0, row;
  const waiting = new Promise(resolve => { release = resolve; });
  const form = make(async () => { writes++; await waiting; ui.showValidationErrors(['redirect_invalid'], row); });
  row = form.row; form.block.value = 'draft.example'; form.redirect.value = 'ftp://draft';
  form.save.focus();
  const first = form.save.dispatch('click');
  await form.save.dispatch('click');
  assert.equal(writes, 1);
  assert.equal(row.getAttribute('aria-busy'), 'true');
  assert.equal(form.save.getAttribute('aria-disabled'), 'true');
  assert.equal(form.block.disabled, true);
  release(); await first;
  assert.equal(row.getAttribute('aria-busy'), null);
  assert.equal(form.block.disabled, false);
  assert.equal(form.redirect.value, 'ftp://draft');
}));

test('editing clears only the owned error description and preserves existing help text', () => editorTest(async ({ document, ui, make }) => {
  let row;
  const form = make(() => ui.showValidationErrors(['blockurl_empty', 'redirect_invalid'], row)); row = form.row;
  form.block.setAttribute('aria-describedby', 'block-help');
  form.save.focus(); await form.save.dispatch('click');
  const errorId = form.block.getAttribute('aria-describedby').split(' ')[1];
  assert.equal(document.getElementById(errorId).textContent, 'blockurl');
  form.block.value = 'corrected.example'; await form.block.dispatch('input');
  assert.equal(form.block.getAttribute('aria-describedby'), 'block-help');
  assert.equal(form.block.getAttribute('aria-invalid'), null);
  assert.equal(document.getElementById(errorId), null);
  assert.equal(form.redirect.getAttribute('aria-invalid'), 'true');
}));

test('independent draft rows have distinct error IDs and keep each other’s values', () => editorTest(async ({ ui, make }) => {
  let first, second;
  first = make(() => ui.showValidationErrors(['redirect_invalid'], first.row));
  second = make(() => ui.showValidationErrors(['redirect_invalid'], second.row));
  first.block.value = 'first.example'; second.block.value = 'second.example';
  first.save.focus(); await first.save.dispatch('click');
  second.save.focus(); await second.save.dispatch('click');
  assert.notEqual(first.redirect.getAttribute('aria-describedby'), second.redirect.getAttribute('aria-describedby'));
  assert.equal(first.block.value, 'first.example'); assert.equal(second.block.value, 'second.example');
}));

test('changing the blocking mode removes errors from the previously visible mode', () => editorTest(async ({ make }) => {
  const form = make(() => {});
  form.mode.value = 'daily_limit'; await form.mode.dispatch('change'); form.daily.value = '0';
  form.save.focus(); await form.save.dispatch('click');
  const errorId = form.daily.getAttribute('aria-describedby'); assert.ok(errorId);
  form.mode.value = 'always'; await form.mode.dispatch('change');
  assert.equal(form.daily.getAttribute('aria-invalid'), null);
  assert.equal(form.daily.getAttribute('aria-describedby'), null);
  assert.equal(form.row.querySelector('.rule-field-error'), null);
}));

test('an asynchronous field error respects a later focus choice and announces one summary', () => editorTest(async ({ document, ui, make, notices }) => {
  let row, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const form = make(async () => { await waiting; ui.showValidationErrors(['redirect_invalid'], row); }); row = form.row;
  const search = document.addElement('search', 'input');
  form.save.focus(); const pending = form.save.dispatch('click');
  search.focus(); await document.dispatch('focusin', { target: search });
  release(); await pending;
  assert.equal(document.activeElement, search);
  assert.equal(form.redirect.getAttribute('aria-invalid'), 'true');
  assert.deepEqual(notices, ['wrongredirecturl - redirecturlhint']);
}));

test('a successful Save resolves focus after replacement of the original row', () => editorTest(async ({ document, make }) => {
  let form;
  const next = document.createElement('button');
  form = make(() => {
    form.row._ruleEditorFeedback.focusAfterSave(() => next);
    form.row.remove(); document.activeElement = document.body; document.body.appendChild(next);
  });
  form.save.focus(); await form.save.dispatch('click');
  assert.equal(document.activeElement, next);
}));

test('a successful Save does not override a later choice made while the response is pending', () => editorTest(async ({ document, make }) => {
  let form, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const add = document.addElement('add', 'button'), search = document.addElement('search', 'input');
  form = make(async () => { await waiting; form.row._ruleEditorFeedback.focusAfterSave(() => add); form.row.remove(); });
  form.save.focus(); const pending = form.save.dispatch('click');
  search.focus(); await document.dispatch('focusin', { target: search });
  release(); await pending;
  assert.equal(document.activeElement, search);
}));

test('whitelist Save restores controls that were disabled before submission', () => editorTest(async ({ document, ui }) => {
  const row = ui.createRuleEditRow({ id: 9, blockURL: 'allowed.example', isWhitelist: true, assignments: [] },
    { listId: 'general', blockingMode: 'always' }, 0, async () => {}, () => {}, () => {}, true);
  document.body.appendChild(row);
  const save = row.querySelector('.save-btn'); save.focus(); await save.dispatch('click');
  assert.equal(row.children[0].querySelector('input').disabled, false);
  assert.equal(row.children[1].querySelector('input').disabled, true);
  assert.equal(row.querySelector('.category-select').disabled, true);
}));

test('unknown callback failures recover the editor and show a safe localized message', () => editorTest(async ({ make, notices }) => {
  const form = make(async () => { throw new Error('private raw failure'); });
  form.block.value = 'draft.example'; form.save.focus(); await form.save.dispatch('click');
  assert.equal(form.block.value, 'draft.example'); assert.equal(form.block.disabled, false);
  assert.equal(form.save.getAttribute('aria-disabled'), null);
  assert.deepEqual(notices, ['errorupdatingrules']);
}));

test('schedule validation describes and focuses the schedule edit control', () => editorTest(async ({ document, ui, make }) => {
  let form;
  form = make(() => ui.showValidationErrors(['schedule_required'], form.row));
  form.mode.value = 'schedule'; await form.mode.dispatch('change'); form.save.focus(); await form.save.dispatch('click');
  const edit = form.row.querySelector('.schedule-edit-button');
  assert.equal(edit.getAttribute('aria-invalid'), 'true'); assert.equal(document.activeElement, edit);
}));

test('duplicate-rule feedback retains contextual text and is associated with the block field', () => editorTest(async ({ document, ui, make }) => {
  let form;
  form = make(() => ui.showValidationErrors(['rule_already_exists'], form.row, { rule_already_exists: 'Already exists\nGeneral: saved.example' }));
  form.save.focus(); await form.save.dispatch('click');
  assert.equal(document.getElementById(form.block.getAttribute('aria-describedby')).textContent, 'Already exists\nGeneral: saved.example');
  assert.equal(document.activeElement, form.block);
}));

test('RulesUI routes errors and successful results through the shared status instead of native alerts', () => editorTest(({ document, ui, tasks, nativeAlerts }) => {
  delete ui.showAlert;
  ui.showErrorMessage('Load failed');
  const region = document.getElementById('custom-alert');
  assert.equal(region.getAttribute('role'), 'status');
  const first = [...tasks].find(([, task]) => task.delay === 100);
  tasks.delete(first[0]); first[1].callback();
  assert.equal(region.textContent, 'Load failed');
  const status = document.addElement('status');
  ui.showSuccessMessage('Saved; synchronization pending', status);
  assert.equal(status.textContent, 'Saved; synchronization pending');
  assert.deepEqual(nativeAlerts, []);
}));

test('readable feedback shares one row across the existing columns and links back to each field', () => editorTest(async ({ document, ui, make }) => {
  let form;
  form = make(() => ui.showValidationErrors(['blockurl_empty', 'redirect_invalid'], form.row));
  form.save.focus(); await form.save.dispatch('click');
  const feedback = document.querySelector('.rule-editor-feedback-row');
  assert.equal(feedback.querySelector('td').colSpan, 5);
  const links = feedback.querySelectorAll('a'); assert.equal(links.length, 2);
  await links[1].dispatch('click');
  assert.equal(document.activeElement, form.redirect);
  assert.equal(links[1].textContent, 'redirecturlheader');
}));

test('cancelling an invalid Add removes its messages with the draft', () => editorTest(async ({ document, ui, make }) => {
  let form;
  form = make(() => ui.showValidationErrors(['redirect_invalid'], form.row));
  form.save.focus(); await form.save.dispatch('click');
  assert.ok(document.querySelector('.rule-editor-feedback-row'));
  const buttons = form.row.querySelectorAll('button');
  await buttons.at(-1).dispatch('click');
  assert.equal(document.querySelector('.rule-editor-row'), null);
  assert.equal(document.querySelector('.rule-editor-feedback-row'), null);
}));
