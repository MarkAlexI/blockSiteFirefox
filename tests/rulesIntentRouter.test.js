import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RULES_INTENT_TYPES,
  createRulesIntentHandler
} from '../rules/rulesIntentRouter.js';

function createHarness() {
  const calls = [];
  const service = {};

  for (const method of [
    'addRule',
    'addMany',
    'updateRule',
    'removeAssignment',
    'deleteRule',
    'toggleRule',
    'replaceAll',
    'clearRules',
    'toggleCategory',
    'createRuleList',
    'renameRuleList',
    'activateRuleList',
    'deleteRuleList'
  ]) {
    service[method] = async payload => {
      calls.push([method, payload]);
      return { method, payload };
    };
  }

  return {
    calls,
    handler: createRulesIntentHandler(service)
  };
}

test('all declared rules intents route to the expected mutation method', async () => {
  const harness = createHarness();
  const payload = { value: 1 };
  const expected = [
    ['rules:add', 'addRule', payload],
    ['rules:addMany', 'addMany', payload],
    ['rules:update', 'updateRule', payload],
    ['rules:removeAssignment', 'removeAssignment', payload],
    ['rules:delete', 'deleteRule', payload],
    ['rules:toggle', 'toggleRule', payload],
    ['rules:replaceAll', 'replaceAll', payload],
    ['rules:clear', 'clearRules', undefined],
    ['rules:toggleCategory', 'toggleCategory', payload],
    ['rules:createList', 'createRuleList', payload],
    ['rules:renameList', 'renameRuleList', payload],
    ['rules:activateList', 'activateRuleList', payload],
    ['rules:toggleList', 'activateRuleList', payload],
    ['rules:deleteList', 'deleteRuleList', payload]
  ];

  assert.deepEqual(
    [...RULES_INTENT_TYPES],
    expected.map(([type]) => type)
  );

  for (const [type, method, expectedPayload] of expected) {
    assert.equal(RULES_INTENT_TYPES.has(type), true);
    const result = await harness.handler({ type, payload });
    assert.equal(result.method, method);
    assert.deepEqual(result.payload, expectedPayload);
  }
});

test('unsupported intents fail explicitly', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.handler({ type: 'rules:unknown' }),
    /Unsupported rules intent/
  );
});
