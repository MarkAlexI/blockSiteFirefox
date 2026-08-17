import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addRuleAssignment,
  getAssignmentUsageKey,
  getRuleAssignment,
  getRuleListIds,
  normalizeRuleAssignments,
  removeRuleAssignment,
  replaceRuleAssignment
} from '../rules/ruleAssignments.js';

test('legacy RC4 memberships become independent assignments with cloned blocking config', () => {
  const assignments = normalizeRuleAssignments({
    id: 1,
    listIds: ['list-1', 'list-2'],
    blockingMode: 'schedule',
    schedule: { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
    isWhitelist: false
  });

  assert.deepEqual(assignments.map(item => item.listId), ['list-1', 'list-2']);
  assert.equal(assignments[0].blockingMode, 'schedule');
  assert.deepEqual(assignments[0].schedule, assignments[1].schedule);
  assert.notEqual(assignments[0].schedule, assignments[1].schedule);
});

test('General and custom profile assignments can coexist independently', () => {
  const rule = {
    assignments: [{ listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null }],
    isWhitelist: false
  };

  const assignments = addRuleAssignment(rule, {
    listId: 'list-1',
    blockingMode: 'schedule',
    schedule: { days: [1], startTime: '09:00', endTime: '10:00' }
  });

  assert.deepEqual(assignments.map(item => item.listId), ['general', 'list-1']);
  assert.equal(getRuleAssignment({ ...rule, assignments }, 'general').blockingMode, 'always');
  assert.equal(getRuleAssignment({ ...rule, assignments }, 'list-1').blockingMode, 'schedule');
});

test('replacing one assignment preserves the other profile configuration', () => {
  const rule = {
    isWhitelist: false,
    assignments: [
      { listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null },
      { listId: 'list-2', blockingMode: 'always', schedule: null, dailyLimit: null }
    ]
  };

  const assignments = replaceRuleAssignment(rule, 'list-2', {
    listId: 'list-2',
    blockingMode: 'daily_limit',
    dailyLimit: { minutes: 20 }
  });
  const nextRule = { ...rule, assignments };

  assert.equal(getRuleAssignment(nextRule, 'general').blockingMode, 'always');
  assert.equal(getRuleAssignment(nextRule, 'list-2').blockingMode, 'daily_limit');
  assert.deepEqual(getRuleAssignment(nextRule, 'list-2').dailyLimit, { minutes: 20 });
});

test('removing the final assignment can either fall back to General or delete cleanly', () => {
  const rule = {
    isWhitelist: false,
    assignments: [{
      listId: 'list-1',
      blockingMode: 'daily_limit',
      schedule: null,
      dailyLimit: { minutes: 25 }
    }]
  };

  assert.deepEqual(removeRuleAssignment(rule, 'list-1'), [{
    listId: 'general',
    disabledByUser: false,
    blockingMode: 'daily_limit',
    schedule: null,
    dailyLimit: { minutes: 25 }
  }]);
  assert.deepEqual(removeRuleAssignment(rule, 'list-1', { fallbackToGeneral: false }), []);
});

test('assignment usage keys identify both target and profile', () => {
  assert.equal(getAssignmentUsageKey(17, 'study'), '17:study');
  assert.deepEqual(getRuleListIds({
    isWhitelist: false,
    assignments: [
      { listId: 'general', blockingMode: 'always' },
      { listId: 'study', blockingMode: 'always' }
    ]
  }), ['general', 'study']);
});

test('enabled state is independent between assignments for the same target', () => {
  const rule = {
    isWhitelist: false,
    assignments: [
      { listId: 'general', disabledByUser: true, blockingMode: 'always' },
      { listId: 'study', disabledByUser: false, blockingMode: 'daily_limit', dailyLimit: { minutes: 20 } }
    ]
  };

  assert.equal(getRuleAssignment(rule, 'general').disabledByUser, true);
  assert.equal(getRuleAssignment(rule, 'study').disabledByUser, false);
});
