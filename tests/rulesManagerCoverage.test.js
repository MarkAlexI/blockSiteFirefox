import test from 'node:test';
import assert from 'node:assert/strict';

import { RulesManager } from '../rules/rulesManager.js';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

test('rule storage returns an empty list when unset and persists complete rule snapshots', async () => {
  const api = createExtensionApi();
  await withExtensionEnvironment(api, async () => {
    const manager = new RulesManager();
    assert.deepEqual(await manager.getRules(), []);
    const rules = [{ id: 1, blockURL: 'blocked.example', redirectURL: '' }];
    await manager.saveRules(rules);
    assert.deepEqual(await manager.getRules(), rules);
  });
});

test('rule storage rejects callback quota failures instead of reporting a successful save', async () => {
  const api = createExtensionApi();
  await withExtensionEnvironment(api, async () => {
    api.storage.local.set = (_values, callback) => {
      api.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
      callback();
      delete api.runtime.lastError;
    };

    await assert.rejects(
      new RulesManager().saveRules([{ id: 1, blockURL: 'blocked.example' }]),
      /QUOTA_BYTES quota exceeded/
    );
    assert.equal(api.storage.local.data.rules, undefined);
  });
});

test('rule storage rejects callback read errors instead of returning an empty rule list', async () => {
  const api = createExtensionApi();
  await withExtensionEnvironment(api, async () => {
    api.storage.local.get = (_key, callback) => {
      api.runtime.lastError = { message: 'Local storage unavailable' };
      callback(undefined);
      delete api.runtime.lastError;
    };

    await assert.rejects(
      new RulesManager().getRules(),
      /Local storage unavailable/
    );
  });
});

test('rule validation rejects invalid UTF-16, unsupported redirects, missing categories, and invalid schedules', () => {
  const manager = new RulesManager();
  const invalidEncoding = manager.validateRule('\uD800', '', null, 'social');
  assert.equal(invalidEncoding.errors.includes('blockurl_invalid'), true);

  const invalidSchedule = manager.validateRule(
    'blocked.example',
    'not-a-url',
    { version: 2, periods: [{ days: [], startTime: '19:00', endTime: '19:00' }] },
    '',
    false,
    'schedule'
  );
  assert.equal(invalidSchedule.errors.includes('redirect_invalid'), true);
  assert.equal(invalidSchedule.errors.includes('invalid_days'), true);
  assert.equal(invalidSchedule.errors.includes('start_after_end'), true);
  assert.equal(invalidSchedule.errors.includes('category_required'), true);
});

test('duplicate rule checks distinguish whitelist targets, redirects, and excluded edit positions', () => {
  const manager = new RulesManager();
  const rules = [
    { blockURL: 'blocked.example', redirectURL: '', isWhitelist: false },
    { blockURL: 'blocked.example', redirectURL: 'https://safe.example/', isWhitelist: false },
    { blockURL: 'allowed.example', redirectURL: '', isWhitelist: true }
  ];

  assert.equal(manager.ruleExists(rules, ' blocked.example ', '', -1, false), true);
  assert.equal(manager.ruleExists(rules, 'blocked.example', '', 0, false), false);
  assert.equal(manager.ruleExists(rules, 'blocked.example', 'https://safe.example/', -1, false), true);
  assert.equal(manager.ruleExists(rules, 'blocked.example', '', -1, true), false);
  assert.equal(manager.ruleExists(rules, ' allowed.example ', 'ignored', -1, true), true);
});

test('conflict checks distinguish blocked targets, whitelist targets, redundant allowances, and excluded edits', () => {
  const manager = new RulesManager();
  const rules = [
    { blockURL: 'blocked.example', isWhitelist: false },
    { blockURL: 'allowed.example', isWhitelist: true }
  ];

  assert.equal(manager.checkConflict(rules, 'BLOCKED.EXAMPLE/team', true), 'conflict_blacklist');
  assert.equal(manager.checkConflict(rules, 'allowed.example/team', false), 'conflict_whitelist');
  assert.equal(manager.checkConflict(rules, 'sub.allowed.example', true), 'redundant_whitelist');
  assert.equal(manager.checkConflict(rules, 'allowed.example', true, 1), null);
  assert.equal(manager.checkConflict(rules, 'independent.example', false), null);
});
