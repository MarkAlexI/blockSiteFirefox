import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnrSynchronizer, getDnrSyncFailureCode } from '../scripts/dnrSynchronizer.js';
import { sanitizeTelemetryError } from '../telemetry/telemetrySanitizer.js';

const rule = { id: 1, blockURL: 'example.invalid', redirectURL: '', isWhitelist: false,
  assignments: [{ listId: 'general', blockingMode: 'always' }] };
const dnrRule = { id: 1, priority: 1, action: { type: 'block' },
  condition: { urlFilter: '||example.invalid', resourceTypes: ['main_frame'] } };
const privateMessage = 'private@example.invalid https://private.invalid/path?key=secret';

function harness(fault = null, { capacity = false, browserQuota = false } = {}) {
  const calls = { get: 0, update: 0, reconcile: 0 }, recorded = [];
  const fail = point => { if (fault === point) throw new Error(privateMessage); };
  const synchronizer = createDnrSynchronizer({
    getRules: async () => { fail('rules'); return capacity ? [rule, { ...rule, id: 2 }] : [rule]; },
    getRuleListState: async () => { fail('lists'); return { lists: [], activeRuleListId: 'general' }; },
    getDailyUsage: async () => { fail('usage'); return {}; },
    getFocusSessionState: async () => { fail('focus'); return { focusActive: fault === 'access' }; },
    getAccess: async () => { fail('access'); return { isPro: true }; },
    isRuleActiveNow: () => { fail('activation'); return true; },
    createDnrRule: async id => { fail('construction'); return { ...dnrRule, id }; },
    closeTabsMatchingRules: async () => { calls.reconcile++; fail('tabs'); },
    declarativeNetRequest: {
      ...(capacity ? { MAX_NUMBER_OF_DYNAMIC_RULES: 1 } : {}),
      async getDynamicRules() { calls.get++; fail('get'); return []; },
      async updateDynamicRules() {
        calls.update++;
        if (browserQuota) throw new Error('Exceeded MAX_NUMBER_OF_DYNAMIC_RULES');
        fail('apply');
      }
    },
    logger: { log() {}, info() {}, warn() {} },
    onSyncResult: async result => { recorded.push(result); }
  });
  return { synchronizer, calls, recorded };
}

for (const [fault, stage, code, expectedGet, expectedUpdate] of [
  ['rules', 'read_state', 'sync_state_read_failed', 0, 0],
  ['lists', 'read_state', 'sync_state_read_failed', 0, 0],
  ['usage', 'read_state', 'sync_state_read_failed', 0, 0],
  ['focus', 'read_state', 'sync_state_read_failed', 0, 0],
  ['access', 'read_state', 'sync_state_read_failed', 0, 0],
  ['activation', 'build_rules', 'sync_rule_build_failed', 0, 0],
  ['construction', 'build_rules', 'sync_rule_build_failed', 0, 0],
  ['get', 'read_dynamic_rules', 'sync_rules_read_failed', 1, 0],
  ['apply', 'apply_rules', 'sync_apply_failed', 1, 1],
  ['tabs', 'reconcile_tabs', 'sync_tab_reconcile_failed', 1, 1]
]) {
  test(`DNR ${fault} failure has a bounded ${stage} fingerprint without private data`, async () => {
    const h = harness(fault);
    const result = await h.synchronizer.requestSync();
    assert.equal(result.success, false);
    assert.equal(result.errorStage, stage);
    assert.equal(h.calls.get, expectedGet);
    assert.equal(h.calls.update, expectedUpdate);
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0], result);
    assert.equal(getDnrSyncFailureCode(result), code);
    const wire = sanitizeTelemetryError({ source: 'dnr', code: getDnrSyncFailureCode(result),
      operation: 'update_dynamic_rules', errorName: result.errorName });
    assert.equal(wire.fingerprint, `dnr:${code}:update_dynamic_rules:error`);
    assert.deepEqual(Object.keys(wire).sort(), ['source', 'code', 'operation', 'errorName', 'fingerprint'].sort());
    for (const secret of ['private@', 'private.invalid', 'key=secret', 'errorStage', 'message', 'stack']) {
      assert.equal(JSON.stringify(wire).includes(secret), false);
    }
  });
}

test('a successful retry clears the failed stage and reaches the browser API', async () => {
  let failed = true;
  const outcomes = [];
  const synchronizer = createDnrSynchronizer({
    getRules: async () => [rule],
    getFocusSessionState: async () => ({ focusActive: false }),
    isRuleActiveNow: () => true,
    createDnrRule: async () => dnrRule,
    closeTabsMatchingRules: async () => {},
    declarativeNetRequest: {
      async getDynamicRules() { if (failed) throw new Error('read refused'); return []; },
      async updateDynamicRules() {}
    },
    logger: { log() {}, info() {}, warn() {} },
    onSyncResult: async result => outcomes.push(result)
  });
  assert.equal((await synchronizer.requestSync()).errorStage, 'read_dynamic_rules');
  failed = false;
  const recovered = await synchronizer.requestSync();
  assert.equal(recovered.success, true);
  assert.equal(recovered.errorStage, undefined);
  assert.equal(outcomes.length, 2);
});

for (const browserQuota of [false, true]) {
  test(`${browserQuota ? 'browser' : 'preflight'} capacity failures retain the established quota fingerprint`, async () => {
    const h = harness(null, { capacity: !browserQuota, browserQuota });
    const result = await h.synchronizer.requestSync();
    assert.equal(result.success, false);
    assert.equal(result.errorStage, browserQuota ? 'apply_rules' : 'check_capacity');
    assert.equal(result.code, 'dnr_rule_limit_reached');
    assert.equal(getDnrSyncFailureCode(result), 'rule_limit_reached');
    assert.equal(h.calls.update, browserQuota ? 1 : 0);
  });
}

test('legacy and unrecognized stages retain the generic code instead of sending arbitrary identifiers', () => {
  for (const errorStage of [undefined, null, {}, 'toString', 'https://private.invalid', 'private@example.invalid']) {
    assert.equal(getDnrSyncFailureCode({ errorStage }), 'sync_failed');
  }
  assert.equal(getDnrSyncFailureCode({ errorCode: 'dnr_rule_limit_reached', errorStage: 'apply_rules' }),
    'rule_limit_reached');
  assert.equal(getDnrSyncFailureCode({ errorStage: 'build_diff' }), 'sync_diff_failed');
  assert.equal(getDnrSyncFailureCode({ errorStage: 'check_capacity' }), 'sync_capacity_check_failed');
});
