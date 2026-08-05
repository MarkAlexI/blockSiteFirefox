import test from 'node:test';
import assert from 'node:assert/strict';

import { isVisibleRuleGroupEnd } from '../rules/visibleRuleGrouping.js';

test('marks boundaries after each complete group of ten visible rules', () => {
  const boundaries = Array.from({ length: 25 }, (_, index) =>
    isVisibleRuleGroupEnd(index, 25)
  );

  assert.equal(boundaries[9], true);
  assert.equal(boundaries[19], true);
  assert.equal(boundaries[24], false);
});

test('does not add a stronger divider after the final visible rule', () => {
  assert.equal(isVisibleRuleGroupEnd(9, 10), false);
  assert.equal(isVisibleRuleGroupEnd(19, 20), false);
});

test('uses the visible filtered count rather than the original rule count', () => {
  assert.equal(isVisibleRuleGroupEnd(9, 12), true);
  assert.equal(isVisibleRuleGroupEnd(9, 8), false);
});

test('rejects invalid indexes, totals, and group sizes', () => {
  assert.equal(isVisibleRuleGroupEnd(-1, 20), false);
  assert.equal(isVisibleRuleGroupEnd(0, 0), false);
  assert.equal(isVisibleRuleGroupEnd(0, 20, 0), false);
  assert.equal(isVisibleRuleGroupEnd(1.5, 20), false);
});
