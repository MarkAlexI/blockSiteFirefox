import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');

test('Options uses one atomic profile refresh path', () => {
  assert.match(source, /async refreshProfileView\(\)/);
  assert.match(source, /this\.rulesManager\.getRules\(\)/);
  assert.match(source, /this\.ruleListsManager\.getState\(\)/);
  assert.match(source, /this\.dailyLimitManager\.getUsageSeconds\(\)/);
  assert.match(source, /RuleListsUI\.updateListGrid/);
  assert.match(source, /this\.renderRules\(/);
  assert.match(source, /CategoryUIManager\.updateCategoryGrid/);
  assert.doesNotMatch(source, /async loadRules\(/);
  assert.doesNotMatch(source, /async loadRuleLists\(/);
  assert.doesNotMatch(source, /async loadCategories\(/);
});

test('rules:changed broadcast requests one coherent refresh', () => {
  const block = source.match(/if \(message\.type === 'rules:changed'\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.equal((block.match(/optionsPage\.refreshProfileView\(\)/g) || []).length, 1);
});
