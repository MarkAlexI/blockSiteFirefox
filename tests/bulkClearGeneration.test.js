import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesClient } from '../rules/rulesClient.js';
import { createRulesMutationService } from '../rules/rulesMutationService.js';
import { createRulesIntentHandler } from '../rules/rulesIntentRouter.js';
import { withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const deferred = () => {
  let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve };
};
function harness({ access = true, getGeneration = null, beforeSave = async () => {} } = {}) {
  let generation = 'shown-generation', rules = [{ id: 1, blockURL: 'saved.example' }], syncs = 0;
  const writes = [], notifications = [], lists = [{ id: 'general', name: 'General', disabledCategories: [] }];
  const service = createRulesMutationService({
    rulesManager: {}, ruleListsManager: { getState: async () => ({ lists, activeRuleListId: 'general' }) },
    getAccess: async () => ({ isPro: access, isLegacyUser: false }),
    getRulesGeneration: () => getGeneration ? getGeneration() : Promise.resolve(generation),
    saveRulesAndLists: async (next, nextLists, active, nextGeneration) => {
      await beforeSave(); rules = next; generation = nextGeneration; writes.push({ rules: next, lists: nextLists, active, generation });
    },
    dnrSynchronizer: { requestSync: async () => { syncs++; return { success: true }; } },
    notifyRulesChanged: (next, extra) => notifications.push({ rules: next, extra })
  });
  return { service, writes, notifications, rules: () => rules, generation: () => generation, syncs: () => syncs };
}

test('Clear client forwards its captured generation and the router preserves it', async () => {
  const sent = [];
  const api = { runtime: { sendMessage(message, callback) {
    sent.push(message); const result = { success: true, rules: [] }; callback?.(result); return Promise.resolve(result);
  } } };
  await withExtensionEnvironment(api, async () => {
    await new RulesClient().clearRules('confirmed-generation');
    assert.deepEqual(sent, [{ type: 'rules:clear', payload: { expectedGeneration: 'confirmed-generation' } }]);
    const handler = createRulesIntentHandler({ clearRules: async payload => payload });
    assert.deepEqual(await handler(sent[0]), { expectedGeneration: 'confirmed-generation' });
  });
});

for (const payload of [{ expectedGeneration: 'older-generation' }, { expectedGeneration: null }, {}]) {
  test(`Clear rejects ${JSON.stringify(payload)} before any saved-state or DNR change`, async () => {
    const h = harness();
    await assert.rejects(h.service.clearRules(payload), error => error.code === 'rules_state_changed');
    assert.deepEqual(h.rules(), [{ id: 1, blockURL: 'saved.example' }]);
    assert.equal(h.generation(), 'shown-generation');
    assert.equal(h.writes.length + h.notifications.length + h.syncs(), 0);
  });
}

test('a matching Clear commits once, keeps Rule Lists and rotates the opaque generation', async () => {
  const h = harness(); const result = await h.service.clearRules({ expectedGeneration: 'shown-generation' });
  assert.deepEqual(result.rules, []); assert.deepEqual(h.rules(), []);
  assert.notEqual(h.generation(), 'shown-generation');
  assert.equal(h.writes.length, 1); assert.equal(h.syncs(), 1);
  assert.equal(h.writes[0].lists[0].id, 'general'); assert.equal(h.writes[0].active, 'general');
});

test('generation read failures and denied access cannot clear saved rules', async () => {
  const readFailure = harness({ getGeneration: async () => { throw new Error('generation unavailable'); } });
  await assert.rejects(readFailure.service.clearRules({ expectedGeneration: 'shown-generation' }), /generation unavailable/);
  assert.equal(readFailure.writes.length + readFailure.syncs(), 0);
  const denied = harness({ access: false, getGeneration: () => assert.fail('denied Clear read generation') });
  await assert.rejects(denied.service.clearRules({ expectedGeneration: 'shown-generation' }), error => error.code === 'pro_required');
  assert.equal(denied.writes.length, 0);
});

test('a Clear queued behind another replacement checks generation after entering the queue', async () => {
  const started = deferred(), release = deferred();
  const h = harness({ beforeSave: async () => { started.resolve(); await release.promise; } });
  const first = h.service.clearRules({ expectedGeneration: 'shown-generation' }); await started.promise;
  const second = h.service.clearRules({ expectedGeneration: 'shown-generation' });
  const rejected = assert.rejects(second, error => error.code === 'rules_state_changed');
  release.resolve(); await first; await rejected;
  assert.equal(h.writes.length, 1); assert.equal(h.syncs(), 1);
});
