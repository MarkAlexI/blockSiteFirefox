import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { t } from '../scripts/t.js';
import { MAX_RULE_LISTS } from '../rules/ruleListsManager.js';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const source = await readFile(new URL('../options/options.js', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class OptionsPage {'), source.indexOf('const optionsPage = new OptionsPage();'));
const OptionsPage = new Function('t', 'MAX_RULE_LISTS', `return ${classSource}`)(t, MAX_RULE_LISTS);

test('all 57 catalogs localize both list-limit hints and the worker rejection with the same numeric limit', async () => {
  const locales = (await readdir(new URL('../_locales/', import.meta.url), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const api = createExtensionApi();
  await withExtensionEnvironment(api, async () => {
    for (const locale of locales) {
      const catalog = JSON.parse(await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
      const entry = catalog.rulelists_limit_reached;
      assert.equal(typeof entry?.message, 'string', `${locale}: translated limit message`);
      assert.equal(entry.placeholders?.limit?.content, '$1', `${locale}: numeric substitution`);
      api.i18n.getMessage = (key, substitutions = []) => {
        const message = catalog[key];
        return message?.message.replace(/\$([a-z_]+)\$/gi, (_, name) => {
          const position = message.placeholders?.[name.toLowerCase()]?.content;
          return substitutions[Number(position?.slice(1)) - 1] ?? '';
        }) || '';
      };
      const expected = entry.message.replace(/\$LIMIT\$/gi, String(MAX_RULE_LISTS));
      const notices = [];
      const page = Object.assign(Object.create(OptionsPage.prototype), {
        ruleLists: Array(MAX_RULE_LISTS).fill({}),
        ruleListNameInput: { value: 'My list', disabled: false, title: '' },
        addRuleListButton: { disabled: false, title: '' },
        rulesUI: { showErrorMessage: message => notices.push(message) }
      });
      page.updateRuleListCreationState();
      assert.equal(page.addRuleListButton.disabled, true, locale);
      assert.equal(page.ruleListNameInput.disabled, true, locale);
      assert.equal(page.addRuleListButton.title, expected, locale);
      assert.equal(page.ruleListNameInput.title, expected, locale);
      page.handleRulesMutationError({ code: 'rule_list_limit_reached' });
      assert.deepEqual(notices, [expected], locale);
      page.ruleLists.pop();
      page.updateRuleListCreationState();
      assert.equal(page.addRuleListButton.disabled, false, locale);
      assert.equal(page.ruleListNameInput.disabled, false, locale);
      assert.equal(page.addRuleListButton.title, '', locale);
      assert.equal(page.ruleListNameInput.title, '', locale);
    }
  });
});
