import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDnrDiff,
  createDnrSynchronizer,
  getDnrSignature
} from '../scripts/dnrSynchronizer.js';

function makeDnrRule({
  id = 1,
  urlFilter = '||example.com',
  redirectUrl = 'blocked.html',
  priority = 1,
  resourceTypes = ['main_frame']
} = {}) {
  return {
    id,
    priority,
    action: {
      type: 'redirect',
      redirect: { url: redirectUrl }
    },
    condition: {
      urlFilter,
      resourceTypes
    }
  };
}

function makeStoredRule({
  id = 1,
  blockURL = 'example.com',
  redirectURL = '',
  active = true,
  isWhitelist = false
} = {}) {
  return {
    id,
    blockURL,
    redirectURL,
    active,
    isWhitelist
  };
}

function createHarness({
  storedRules = [makeStoredRule()],
  currentDnrRules = [],
  createRule,
  getRules
} = {}) {
  const updates = [];
  const closedUrlBatches = [];
  const logs = [];
  let dynamicRules = structuredClone(currentDnrRules);

  const rulesManager = {
    getRules: getRules ?? (async () => structuredClone(storedRules)),
    isRuleActiveNow: rule => rule.active !== false,
    createDNRRule: createRule ?? (async (id, blockURL, redirectURL) =>
      makeDnrRule({
        id,
        urlFilter: `||${blockURL}`,
        redirectUrl: redirectURL || 'blocked.html'
      }))
  };

  const declarativeNetRequest = {
    async getDynamicRules() {
      return structuredClone(dynamicRules);
    },
    async updateDynamicRules(update) {
      updates.push(structuredClone(update));
      const removed = new Set(update.removeRuleIds ?? []);
      dynamicRules = dynamicRules.filter(rule => !removed.has(rule.id));
      dynamicRules.push(...structuredClone(update.addRules ?? []));
    }
  };

  const logger = {
    log: (...args) => logs.push(['log', ...args]),
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args])
  };

  const synchronizer = createDnrSynchronizer({
    rulesManager,
    getSettings: async () => ({ disabledCategories: [] }),
    getFocusSessionState: async () => ({ focusActive: false }),
    closeTabsMatchingRules: async urls => {
      closedUrlBatches.push([...urls]);
    },
    declarativeNetRequest,
    logger
  });

  return {
    synchronizer,
    updates,
    closedUrlBatches,
    logs,
    getDynamicRules: () => structuredClone(dynamicRules)
  };
}

test('DNR signature ignores resourceTypes order', () => {
  const first = makeDnrRule({
    resourceTypes: ['sub_frame', 'main_frame']
  });
  const second = makeDnrRule({
    resourceTypes: ['main_frame', 'sub_frame']
  });

  assert.equal(getDnrSignature(first), getDnrSignature(second));
});

test('identical DNR sets produce an empty diff', () => {
  const rule = makeDnrRule();

  assert.deepEqual(buildDnrDiff([rule], [structuredClone(rule)]), {
    removeRuleIds: [],
    addRules: []
  });
});

test('new and removed rules are returned selectively', () => {
  const current = makeDnrRule({ id: 1 });
  const expected = makeDnrRule({ id: 2 });

  assert.deepEqual(buildDnrDiff([current], [expected]), {
    removeRuleIds: [1],
    addRules: [expected]
  });
});

test('an edited rule with the same ID is replaced atomically', () => {
  const current = makeDnrRule({ id: 7, urlFilter: '||old.example' });
  const expected = makeDnrRule({ id: 7, urlFilter: '||new.example' });

  assert.deepEqual(buildDnrDiff([current], [expected]), {
    removeRuleIds: [7],
    addRules: [expected]
  });
});

test('redirect and priority changes are detected', () => {
  const current = makeDnrRule({ id: 3 });
  const expected = makeDnrRule({
    id: 3,
    redirectUrl: 'https://example.org',
    priority: 2
  });

  const diff = buildDnrDiff([current], [expected]);
  assert.deepEqual(diff.removeRuleIds, [3]);
  assert.deepEqual(diff.addRules, [expected]);
});

test('synchronization skips the DNR API when rules are already current', async () => {
  const current = makeDnrRule();
  const harness = createHarness({ currentDnrRules: [current] });

  await harness.synchronizer.requestSync();

  assert.equal(harness.updates.length, 0);
  assert.deepEqual(harness.closedUrlBatches, [['example.com']]);
});

test('synchronization applies one atomic remove/add for an edited stable ID', async () => {
  const current = makeDnrRule({ id: 1, urlFilter: '||old.example' });
  const harness = createHarness({
    storedRules: [makeStoredRule({ id: 1, blockURL: 'new.example' })],
    currentDnrRules: [current]
  });

  await harness.synchronizer.requestSync();

  assert.equal(harness.updates.length, 1);
  assert.deepEqual(harness.updates[0].removeRuleIds, [1]);
  assert.equal(harness.updates[0].addRules[0].id, 1);
  assert.equal(
    harness.updates[0].addRules[0].condition.urlFilter,
    '||new.example'
  );
});

test('overlapping sync requests are serialized and rerun with fresh state', async () => {
  let getRulesCalls = 0;
  let releaseFirstRead;
  let firstReadStarted;
  const firstReadStartedPromise = new Promise(resolve => {
    firstReadStarted = resolve;
  });
  const firstReadGate = new Promise(resolve => {
    releaseFirstRead = resolve;
  });

  const getRules = async () => {
    getRulesCalls += 1;

    if (getRulesCalls === 1) {
      firstReadStarted();
      await firstReadGate;
      return [makeStoredRule({ blockURL: 'first.example' })];
    }

    return [makeStoredRule({ blockURL: 'second.example' })];
  };

  const harness = createHarness({ getRules });
  const firstSync = harness.synchronizer.requestSync();
  await firstReadStartedPromise;
  const secondSync = harness.synchronizer.requestSync();

  assert.strictEqual(firstSync, secondSync);

  releaseFirstRead();
  await Promise.all([firstSync, secondSync]);

  assert.equal(getRulesCalls, 2);
  assert.equal(harness.updates.length, 2);
  assert.equal(
    harness.getDynamicRules()[0].condition.urlFilter,
    '||second.example'
  );
});

test('integrity validation compares against active rules and repairs drift', async () => {
  const harness = createHarness({
    storedRules: [
      makeStoredRule({ id: 1, blockURL: 'active.example' }),
      makeStoredRule({ id: 2, blockURL: 'inactive.example', active: false }),
      makeStoredRule({ id: 3, blockURL: 'allow.example', isWhitelist: true })
    ],
    currentDnrRules: []
  });

  const isInSync = await harness.synchronizer.validateIntegrity();

  assert.equal(isInSync, false);
  assert.equal(harness.updates.length, 1);
  assert.deepEqual(
    harness.updates[0].addRules.map(rule => rule.id),
    [1]
  );
});
