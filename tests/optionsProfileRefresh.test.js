import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const popupSource = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

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

test('Options and Popup derive Pro and legacy state from one credential snapshot', () => {
  for (const pageSource of [source, popupSource]) {
    assert.match(pageSource, /const access = await ProManager\.getAccess\(\)/);
    assert.match(pageSource, /this\.isPro = access\.isPro/);
    assert.match(pageSource, /this\.isLegacyUser = access\.isLegacyUser/);
    assert.doesNotMatch(pageSource, /this\.isPro = await ProManager\.isPro\(\)/);
    assert.doesNotMatch(pageSource, /this\.isLegacyUser = await ProManager\.isLegacyUser\(\)/);
  }
});

test('Options and Popup keep legacy-only features visible after a Pro status change', () => {
  assert.match(source, /updateProFeaturesVisibility\(message\.isPro \|\| optionsPage\.isLegacyUser\)/);
  assert.match(popupSource, /updateProFeaturesVisibility\(message\.isPro \|\| popupPage\.isLegacyUser\)/);
});


test('Options gates Rule List creation at seven profiles and avoids error logging for expected rejections', () => {
  assert.match(source, /this\.ruleLists\.length >= MAX_RULE_LISTS/);
  assert.match(source, /this\.addRuleListButton\.disabled = limitReached \|\| !hasName/);
  assert.match(source, /isExpectedRulesRejection\(error\)/);
  assert.match(source, /this\.logger\.info\(label/);
});
