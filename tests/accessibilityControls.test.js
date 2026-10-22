import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { initializeCollapsibleSections } from '../dom/collapsibleSections.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

function addSection(document, expanded) {
  const section = document.createElement('section');
  section.className = 'collapsible-section';
  const button = document.createElement('button');
  button.className = 'collapsible-toggle';
  button.setAttribute('aria-expanded', String(expanded));
  const panel = document.createElement('div');
  panel.className = 'collapsible-content';
  const input = document.createElement('input');
  input.value = 'Unsaved draft';
  panel.appendChild(input);
  section.append(button, panel);
  document.body.appendChild(section);
  return { section, button, panel, input };
}

test('disclosure toggles hide only their own panel and retain drafts through close/reopen', async () => {
  const document = new FakeDocument();
  const first = addSection(document, false);
  const second = addSection(document, true);
  initializeCollapsibleSections(document);
  assert.equal(first.panel.hidden, true);
  assert.equal(second.panel.hidden, false);
  await first.button.dispatch('click');
  assert.equal(first.panel.hidden, false);
  assert.equal(first.button.getAttribute('aria-expanded'), 'true');
  assert.equal(first.section.classList.contains('expanded'), true);
  first.input.value = 'Changed draft';
  await first.button.dispatch('click');
  assert.equal(first.panel.hidden, true);
  assert.equal(first.button.getAttribute('aria-expanded'), 'false');
  assert.equal(first.section.classList.contains('expanded'), false);
  assert.equal(second.panel.hidden, false);
  await first.button.dispatch('click');
  assert.equal(first.input.value, 'Changed draft');
  assert.equal(first.panel.children[0], first.input);
});

test('new and edited rule controls have localized names for Free, Pro and whitelist rows', async () => {
  await withExtensionEnvironment(createExtensionApi(), async () => {
    const { RulesUI } = await import('../rules/rulesUI.js');
    const ui = new RulesUI();
    const assignment = { listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null };
    try {
      for (const paid of [false, true]) {
        for (const whitelist of [false, true]) {
          const rule = { id: 1, blockURL: 'example.test', category: whitelist ? 'whitelist' : 'social',
            isWhitelist: whitelist, assignments: [assignment] };
          const rows = [ui.createAddRuleRow(() => {}, () => {}, paid, whitelist),
            ui.createRuleEditRow(rule, assignment, 0, () => {}, () => {}, () => {}, paid)];
          for (const row of rows) {
            assert.equal(row.querySelector('input').getAttribute('aria-label'), 'blockurl');
            assert.equal(row.children[2].querySelector('select').getAttribute('aria-label'), 'category_header');
            if (!whitelist) {
              const mode = row.querySelector('.blocking-mode-select');
              assert.equal(mode.getAttribute('aria-label'), 'blockingmode_header');
              assert.equal(mode.value, 'always');
              assert.equal(mode.disabled, false);
            }
          }
        }
      }
    } finally { ui.cleanup(); }
  }, { document: new FakeDocument() });
});

test('attribute-only translations preserve the scroll icon and use each locale', async () => {
  const document = new FakeDocument();
  const button = document.addElement('scrollToTopBtn', 'button');
  button.setAttribute('data-i18n-aria-label', 'scrolltotop');
  const icon = document.createElement('span');
  icon.textContent = '↑';
  button.appendChild(icon);
  const api = createExtensionApi();
  api.i18n.getMessage = key => key === 'scrolltotop' ? 'Повернутися вгору' : key;
  await withExtensionEnvironment(api, async () => {
    await import('../scripts/i18n.js?accessibility-controls');
    assert.equal(button.getAttribute('aria-label'), 'Повернутися вгору');
    assert.equal(button.children[0], icon);
    assert.equal(icon.textContent, '↑');
  }, { document });
  const directory = new URL('../_locales/', import.meta.url);
  const locales = readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory());
  assert.equal(locales.length, 57);
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(new URL(`${locale.name}/messages.json`, directory), 'utf8'));
    for (const key of ['scrolltotop', 'category_header', 'blockingmode_header', 'searchfordomain', 'rulelists_name_placeholder']) {
      assert.ok(messages[key]?.message.trim(), `${locale.name}: ${key}`);
    }
  }
});
