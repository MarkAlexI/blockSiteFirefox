import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostPermissionMonitor, affectsRequiredHostAccess } from '../utils/hostPermissionMonitor.js';

function createHarness({ granted = true, previousHostAccess } = {}) {
  let hostAccess = granted;
  const tabs = [];
  const events = [];
  let state = previousHostAccess === undefined ? {} : {
    lastPermissionCheck: { hostAccess: previousHostAccess, timestamp: 1, reason: 'previous' }
  };

  const monitor = createHostPermissionMonitor({
    permissionsApi: {
      async contains() { return hostAccess; }
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
      async updateState(patch) { state = { ...state, ...structuredClone(patch) }; },
      async recordEvent(level, source, code, details) {
        events.push({ level, source, code, details });
      }
    },
    logger: { warn() {}, error() {} },
    now: () => 100
  });

  return {
    monitor,
    tabs,
    events,
    getState: () => state,
    setHostAccess(value) { hostAccess = value; }
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


test('permission change matching accepts both manifest and all-URLs forms', () => {
  assert.equal(affectsRequiredHostAccess(['*://*/*']), true);
  assert.equal(affectsRequiredHostAccess(['<all_urls>']), true);
  assert.equal(affectsRequiredHostAccess(['https://example.com/*']), false);
});
