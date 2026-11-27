import test from 'node:test';
import assert from 'node:assert/strict';
import { createDnrSyncHealth, DNR_FAILURE_OBSERVATION_INTERVAL_MS as INTERVAL } from '../diagnostics/dnrSyncHealth.js';

const failed = { success: false, errorStage: 'read_dynamic_rules', error: 'https://private.invalid/?key=secret' };
const success = { success: true, changed: false };
function harness(initial = {}) {
  let at = 1_000_000, state = structuredClone(initial), writes = 0;
  const counters = [];
  const diagnosticStore = {
    async getState() { return structuredClone(state); },
    async updateState(patch) { writes++; state = { ...state, ...structuredClone(patch) }; }
  };
  const telemetryStore = { async incrementCounter(counter) { counters.push(counter); } };
  const make = () => createDnrSyncHealth({ diagnosticStore, telemetryStore, now: () => at });
  return { make, diagnosticStore, counters, get state() { return state; }, get writes() { return writes; },
    advance(ms) { at += ms; } };
}

test('healthy drains do not create a health record or recovery counter', async () => {
  const h = harness(), monitor = h.make();
  await monitor.record(success);
  await monitor.record(success);
  assert.equal(h.writes, 0);
  assert.deepEqual(h.counters, []);
});

test('a failure observation interval survives restart and is counted only once', async () => {
  const h = harness(), monitor = h.make();
  await monitor.record(failed, { triggers: ['minute_alarm'] });
  h.advance(INTERVAL - 1);
  const restarted = h.make();
  await restarted.record(failed);
  assert.equal(h.writes, 1);
  h.advance(1);
  await Promise.all([restarted.record(failed), restarted.record(failed)]);
  assert.equal(h.writes, 2);
  assert.equal(h.state.dnrSyncHealth.observations, 2);
  assert.deepEqual(h.counters, ['dnr_sync_failure_observed', 'dnr_sync_failure_observed']);
});

test('a changed failure stage updates diagnostics without bypassing the observation throttle', async () => {
  const h = harness(), monitor = h.make();
  await monitor.record(failed, { triggers: ['startup'] });
  await monitor.record({ ...failed, errorStage: 'apply_rules' }, {
    triggers: ['minute_alarm', 'minute_alarm', 'https://private.invalid/?key=secret', { email: 'private@example.invalid' }]
  });
  assert.equal(h.writes, 2);
  assert.equal(h.state.dnrSyncHealth.lastCode, 'sync_apply_failed');
  assert.deepEqual(h.state.dnrSyncHealth.lastFailureTriggers, ['minute_alarm', 'unknown']);
  assert.equal(h.counters.length, 1);
  assert.doesNotMatch(JSON.stringify(h.state), /private|secret|example/);
});

test('recovery is observed once after restart even when the browser needed no rule changes', async () => {
  const h = harness();
  await h.make().record(failed);
  h.advance(1234);
  const restarted = h.make();
  await Promise.all([restarted.record(success, { triggers: ['startup'] }), restarted.record(success)]);
  assert.equal(h.state.dnrSyncHealth.active, false);
  assert.equal(h.state.dnrSyncHealth.lastRecoveryDurationMs, 1234);
  assert.deepEqual(h.counters, ['dnr_sync_failure_observed', 'dnr_sync_recovered']);
  await h.make().record(success);
  assert.equal(h.writes, 2);
});

test('a failed health write can be retried without claiming a persisted observation', async () => {
  const h = harness(), write = h.diagnosticStore.updateState;
  h.diagnosticStore.updateState = async () => { throw new Error('storage unavailable'); };
  const monitor = h.make();
  await assert.rejects(monitor.record(failed), /storage unavailable/);
  assert.deepEqual(h.counters, []);
  h.diagnosticStore.updateState = write;
  await monitor.record(failed);
  assert.equal(h.writes, 1);
  assert.equal(h.counters.length, 1);
});

test('a new failure after recovery starts a new measured streak', async () => {
  const h = harness(), monitor = h.make();
  await monitor.record(failed);
  await monitor.record(success);
  h.advance(INTERVAL);
  await monitor.record(failed);
  assert.equal(h.state.dnrSyncHealth.active, true);
  assert.equal(h.state.dnrSyncHealth.observations, 1);
  assert.deepEqual(h.counters, ['dnr_sync_failure_observed', 'dnr_sync_recovered', 'dnr_sync_failure_observed']);
});
