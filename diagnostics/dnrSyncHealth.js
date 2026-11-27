import { getDnrSyncFailureCode, normalizeDnrSyncTrigger } from '../scripts/dnrSynchronizer.js';

export const DNR_FAILURE_OBSERVATION_INTERVAL_MS = 15 * 60_000;
const MAX_OBSERVATIONS = 1_000_000;
const failureCodes = new Set(['rule_limit_reached', 'sync_failed', 'sync_state_read_failed',
  'sync_rule_build_failed', 'sync_rules_read_failed', 'sync_diff_failed',
  'sync_capacity_check_failed', 'sync_apply_failed', 'sync_tab_reconcile_failed']);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const triggers = values => [...new Set((Array.isArray(values) ? values : [])
  .slice(0, 20).map(normalizeDnrSyncTrigger))].sort();

function readHealth(value) {
  if (value?.version !== 1 || typeof value.active !== 'boolean') return null;
  return {
    version: 1,
    active: value.active,
    firstFailureAt: timestamp(value.firstFailureAt),
    lastObservationAt: timestamp(value.lastObservationAt),
    observations: Math.max(1, Math.min(MAX_OBSERVATIONS, Math.floor(Number(value.observations) || 1))),
    lastCode: failureCodes.has(value.lastCode) ? value.lastCode : 'sync_failed',
    lastFailureTriggers: triggers(value.lastFailureTriggers),
    recoveredAt: timestamp(value.recoveredAt),
    lastRecoveryDurationMs: timestamp(value.lastRecoveryDurationMs),
    recoveryTriggers: triggers(value.recoveryTriggers)
  };
}

// These are observations of failed drains, not a count of API calls or affected users.
// Keep the throttle durable across worker restarts without minute-by-minute writes.
export function createDnrSyncHealth({ diagnosticStore, telemetryStore, now = () => Date.now() }) {
  let loaded = false, health = null, tail = Promise.resolve();

  async function record(result, metadata = {}) {
    if (!loaded) {
      health = readHealth((await diagnosticStore.getState()).dnrSyncHealth);
      loaded = true;
    }
    const at = timestamp(now());
    const observedTriggers = triggers(metadata.triggers);
    let next, counter;
    if (result.success === true) {
      if (!health?.active) return { recovered: false };
      next = { ...health, active: false, recoveredAt: at,
        lastRecoveryDurationMs: Math.max(0, at - health.firstFailureAt),
        recoveryTriggers: observedTriggers };
      counter = 'dnr_sync_recovered';
    } else if (result.success === false) {
      const code = getDnrSyncFailureCode(result);
      if (!health?.active) {
        next = { version: 1, active: true, firstFailureAt: at, lastObservationAt: at,
          observations: 1, lastCode: code, lastFailureTriggers: observedTriggers,
          recoveredAt: 0, lastRecoveryDurationMs: 0, recoveryTriggers: [] };
        counter = 'dnr_sync_failure_observed';
      } else {
        const due = at < health.lastObservationAt ||
          at - health.lastObservationAt >= DNR_FAILURE_OBSERVATION_INTERVAL_MS;
        if (!due && health.lastCode === code) return { recovered: false };
        next = { ...health, lastCode: code, lastFailureTriggers: observedTriggers,
          ...(due ? { lastObservationAt: at, observations: Math.min(MAX_OBSERVATIONS, health.observations + 1) } : {}) };
        if (due) counter = 'dnr_sync_failure_observed';
      }
    } else return { recovered: false };

    // Persist first: a restarted worker must not count the same recovery again.
    await diagnosticStore.updateState({ dnrSyncHealth: next });
    health = next;
    if (counter) await telemetryStore.incrementCounter(counter);
    return { recovered: result.success === true };
  }

  return {
    record(result, metadata) {
      const run = tail.then(() => record(result, metadata));
      tail = run.catch(() => {});
      return run;
    }
  };
}
