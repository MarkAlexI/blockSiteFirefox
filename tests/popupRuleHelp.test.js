import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeDocument } from './helpers/extensionTestHarness.js';

const source = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class PopupPage {'), source.indexOf('const popupPage = new PopupPage();'));

test('both Popup settings buttons use the existing navigation handler without changing rules', async () => {
  const document = new FakeDocument();
  const buttons = {};
  for (const id of ['options-link', 'rule-help-options', 'feedback-btn', 'add-rule', 'scrollToTopBtn']) {
    buttons[id] = document.addElement(id, 'button');
  }
  const PopupPage = new Function('document', `return ${classSource}`)(document);
  const actions = [];
  const page = Object.assign(Object.create(PopupPage.prototype), {
    addRuleButton: buttons['add-rule'], scrollToTopBtn: buttons.scrollToTopBtn,
    openOptionsPage: () => actions.push('options'),
    createRuleInputs: () => actions.push('create-rule'),
    rulesManager: { getRules: () => { throw new Error('Navigation must not read or change rules'); } }
  });
  page.setupEventListeners();
  assert.deepEqual(actions, [], 'installing help never opens a page or changes rules');
  for (const id of ['options-link', 'rule-help-options']) {
    let prevented = false;
    await buttons[id].dispatch('click', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, id);
  }
  assert.deepEqual(actions, ['options', 'options']);
});
