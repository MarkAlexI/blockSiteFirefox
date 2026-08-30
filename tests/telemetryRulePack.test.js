import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULE_PACK_ATTEMPT_COUNTERS,
  RULE_PACK_TELEMETRY_COUNTERS,
  getRulePackTelemetryIncrements
} from '../telemetry/telemetryRulePack.js';

test('Rule Pack telemetry exposes only the eight fixed built-in pack counters', () => {
  assert.deepEqual(RULE_PACK_ATTEMPT_COUNTERS, {
    social: 'rule_pack_attempt_social',
    messaging: 'rule_pack_attempt_messaging',
    video: 'rule_pack_attempt_video',
    'short-video': 'rule_pack_attempt_short_video',
    streaming: 'rule_pack_attempt_streaming',
    news: 'rule_pack_attempt_news',
    shopping: 'rule_pack_attempt_shopping',
    gaming: 'rule_pack_attempt_gaming'
  });
  assert.equal(new Set(RULE_PACK_TELEMETRY_COUNTERS).size, RULE_PACK_TELEMETRY_COUNTERS.length);
});

test('Rule Pack telemetry preserves existing import semantics and separates assignments', () => {
  assert.deepEqual(getRulePackTelemetryIncrements({
    packId: 'shopping',
    addedCount: 3,
    newRuleCount: 2,
    assignmentAddedCount: 1,
    skippedDuplicates: 2,
    conflicts: [{ code: 'conflict_whitelist' }]
  }), [
    ['rule_pack_attempt_shopping', 1],
    ['rule_pack_imported', 1],
    ['rule_pack_rules_added', 2],
    ['rule_pack_assignments_added', 1],
    ['rule_pack_duplicates_skipped', 2],
    ['rule_pack_conflicts', 1]
  ]);
});

test('Rule Pack telemetry records duplicate and conflict-only attempts as no-change', () => {
  assert.deepEqual(getRulePackTelemetryIncrements({
    packId: 'short-video',
    addedCount: 0,
    newRuleCount: 0,
    assignmentAddedCount: 0,
    skippedDuplicates: 3,
    conflicts: [{ code: 'conflict_whitelist' }]
  }), [
    ['rule_pack_attempt_short_video', 1],
    ['rule_pack_duplicates_skipped', 3],
    ['rule_pack_conflicts', 1],
    ['rule_pack_no_change', 1]
  ]);
});

test('Rule Pack telemetry rejects arbitrary pack IDs and malformed counts', () => {
  assert.deepEqual(getRulePackTelemetryIncrements({
    packId: 'private-pack-name',
    addedCount: 10
  }), []);
  assert.deepEqual(getRulePackTelemetryIncrements({
    packId: 'social',
    addedCount: -1,
    newRuleCount: 'private',
    assignmentAddedCount: 1.5,
    skippedDuplicates: Number.NaN,
    conflicts: 'not-an-array'
  }), [
    ['rule_pack_attempt_social', 1],
    ['rule_pack_no_change', 1]
  ]);
});
