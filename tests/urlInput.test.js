import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FakeDocument,
  createExtensionApi,
  withExtensionEnvironment
} from './helpers/extensionTestHarness.js';
import { configureUrlInput } from '../dom/urlInput.js';

function assertUrlInputConfiguration(input) {
  assert.equal(input.type, 'text');
  assert.equal(input.getAttribute('autocorrect'), 'off');
  assert.equal(input.getAttribute('autocapitalize'), 'none');
  assert.equal(input.spellcheck, false);
  assert.equal(input.inputMode, 'url');
}

test('URL input configuration preserves text semantics and disables writing assistance', () => {
  const input = new FakeDocument().createElement('input');
  input.type = 'text';

  assert.equal(configureUrlInput(input), input);
  assertUrlInputConfiguration(input);
});

test('Options configures block and redirect fields while adding and editing rules', async () => {
  const document = new FakeDocument();
  const api = createExtensionApi();
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;

  try {
    await withExtensionEnvironment(api, async () => {
      const { RulesUI } = await import('../rules/rulesUI.js');
      const rulesUI = new RulesUI();
      const assignment = {
        listId: 'general',
        disabledByUser: false,
        blockingMode: 'always',
        schedule: null,
        dailyLimit: null
      };
      const rule = {
        id: 17,
        blockURL: 'example.com/path',
        redirectURL: 'https://safe.example/',
        category: 'social',
        assignments: [assignment],
        isWhitelist: false
      };

      const rows = [
        rulesUI.createAddRuleRow(() => {}, () => {}),
        rulesUI.createRuleEditRow(rule, assignment, 0, () => {}, () => {}, () => {})
      ];

      for (const row of rows) {
        assertUrlInputConfiguration(row.children[0].querySelector('input'));
        assertUrlInputConfiguration(row.children[1].querySelector('input'));
      }
    }, { document });
  } finally {
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('all six dynamic rule URL fields use the shared configuration', () => {
  const rulesSource = readFileSync(new URL('../rules/rulesUI.js', import.meta.url), 'utf8');
  const popupSource = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
  const count = (source, expression) => source.match(expression)?.length || 0;

  assert.equal(count(rulesSource, /configureUrlInput\(blockInput\);/g), 2);
  assert.equal(count(rulesSource, /configureUrlInput\(redirectInput\);/g), 2);
  assert.equal(count(popupSource, /configureUrlInput\(blockURL\);/g), 1);
  assert.equal(count(popupSource, /configureUrlInput\(redirectURL\);/g), 1);
});
