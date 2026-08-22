import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHostPermissionMonitor,
  affectsRequiredHostAccess,
  PERMISSION_CHECK_PERSIST_INTERVAL_MS
} from '../utils/hostPermissionMonitor.js';

function createHarness({
  granted = true,
  previousHostAccess,
  previousTimestamp = 1,
  timestamp = 100
} = {}) {
  let hostAccess = granted;
  let currentTime = timestamp;
  let permissionChecks = 0;
  let stateUpdates = 0;
  const tabs = [];
  const events = [];
  let state = previousHostAccess === undefined ? {} : {
    lastPermissionCheck: {
      hostAccess: previousHostAccess,
      timestamp: previousTimestamp,
      reason: 'previous'
    }
  };

  const monitor = createHostPermissionMonitor({
    permissionsApi: {
      async contains() {
        permissionChecks++;
        return hostAccess;
      }
    },
    tabsApi: {
      async query() { return tabs.filter(tab => tab.onboarding); },
      async create(options) {
        tabs.push({ ...options, onboarding: true });
        return tabs.at(-1);
      }
    },
    runtimeApi: {
      getURL(path) { return `moz-extension://test/${path}`; }
    },
    diagnosticStore: {
      async getState() { return structuredClone(state); },
      async updateState(patch) {
        stateUpdates++;
        state = { ...state, ...structuredClone(patch) };
      },
      async recordEvent(level, source, code, details) {
        events.push({ level, source, code, details });
      }
    },
    logger: { warn() {}, error() {} },
    now: () => currentTime
  });

  return {
    monitor,
    tabs,
    events,
    getState: () => state,
    getPermissionChecks: () => permissionChecks,
    getStateUpdates: () => stateUpdates,
    setHostAccess(value) { hostAccess = value; },
    setNow(value) { currentTime = value; }
  };
}

test('permission watchdog opens onboarding when scheduled check detects a transition to missing', async () => {
  const harness = createHarness({ granted: false, previousHostAccess: true });
  const result = await harness.monitor.check({ reason: 'scheduled_alarm' });

  assert.equal(result.granted, false);
  assert.equal(result.transitionedToMissing, true);
  assert.equal(result.notified, true);
  assert.equal(harness.tabs.length, 1);
  assert.equal(harness.getState().lastPermissionCheck.reason, 'scheduled_alarm');
  assert.equal(harness.events[0].code, 'host_access_missing');
});

test('repeated scheduled checks do not reopen onboarding for the same missing state', async () => {
  const harness = createHarness({ granted: false, previousHostAccess: true });
  await harness.monitor.check({ reason: 'scheduled_alarm' });
  harness.tabs.length = 0;

  const repeated = await harness.monitor.check({ reason: 'scheduled_alarm' });
  assert.equal(repeated.transitionedToMissing, false);
  assert.equal(repeated.notified, false);
  assert.equal(harness.tabs.length, 0);
});

test('explicit startup and removal checks notify even when missing access was already known', async () => {
  const harness = createHarness({ granted: false, previousHostAccess: false });
  const result = await harness.monitor.check({
    reason: 'startup',
    notifyIfMissing: true
  });

  assert.equal(result.notified, true);
  assert.equal(harness.tabs.length, 1);
});

test('permission watchdog records restored access without opening onboarding', async () => {
  const harness = createHarness({ granted: true, previousHostAccess: false });
  const result = await harness.monitor.check({ reason: 'permission_added' });

  assert.equal(result.transitionedToGranted, true);
  assert.equal(result.notified, false);
  assert.equal(harness.events[0].code, 'host_access_restored');
  assert.equal(harness.getState().lastPermissionCheck.hostAccess, true);
});

test('stable scheduled permission checks keep running without rewriting diagnostics', async () => {
  const harness = createHarness({
    granted: true,
    previousHostAccess: true,
    previousTimestamp: 10,
    timestamp: 100
  });

  await harness.monitor.check({ reason: 'scheduled_alarm' });
  harness.setNow(60_100);
  await harness.monitor.check({ reason: 'scheduled_alarm' });

  assert.equal(harness.getPermissionChecks(), 2);
  assert.equal(harness.getStateUpdates(), 0);
  assert.equal(harness.getState().lastPermissionCheck.timestamp, 10);
});

test('stable scheduled permission diagnostics are refreshed after their persistence interval', async () => {
  const harness = createHarness({
    granted: true,
    previousHostAccess: true,
    previousTimestamp: 100,
    timestamp: 100 + PERMISSION_CHECK_PERSIST_INTERVAL_MS
  });

  await harness.monitor.check({ reason: 'scheduled_alarm' });

  assert.equal(harness.getPermissionChecks(), 1);
  assert.equal(harness.getStateUpdates(), 1);
  assert.equal(
    harness.getState().lastPermissionCheck.timestamp,
    100 + PERMISSION_CHECK_PERSIST_INTERVAL_MS
  );
});

test('explicit permission checks and access transitions are persisted immediately', async () => {
  const harness = createHarness({
    granted: true,
    previousHostAccess: true,
    previousTimestamp: 10,
    timestamp: 100
  });

  await harness.monitor.check({ reason: 'startup' });
  assert.equal(harness.getStateUpdates(), 1);
  assert.equal(harness.getState().lastPermissionCheck.reason, 'startup');

  harness.setHostAccess(false);
  harness.setNow(101);
  await harness.monitor.check({ reason: 'scheduled_alarm' });

  assert.equal(harness.getStateUpdates(), 2);
  assert.equal(harness.getState().lastPermissionCheck.hostAccess, false);
  assert.equal(harness.tabs.length, 1);
});


test('permission change matching accepts both manifest and all-URLs forms', () => {
  assert.equal(affectsRequiredHostAccess(['*://*/*']), true);
  assert.equal(affectsRequiredHostAccess(['<all_urls>']), true);
  assert.equal(affectsRequiredHostAccess(['https://example.com/*']), false);
});
