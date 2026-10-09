import test from 'node:test';
import assert from 'node:assert/strict';
import { assertColdReplies, assertColdState } from '../e2e/cold-message.mjs';

function proof() {
  const before = { rules: [{ id: 21 }, { id: 22 }], rulesGeneration: 'persisted-generation',
    ruleRevisions: { 21: 'daily-revision', 22: 'study-revision' }, activeRuleListId: 'general',
    ruleLists: [{ id: 'general', name: 'General' }, { id: 'list-1', name: 'Study' }, { id: 'list-2', name: 'Work' }],
    ruleListRevisions: { general: 'general-revision', 'list-1': 'study-list-revision', 'list-2': 'work-list-revision' },
    focusSession: { focusActive: true, focusEndTime: 600_000, isHardcore: true, focusMode: 'blacklist' },
    dailyRuleUsage: { usageSeconds: { '21:general': 840 } }, pendingDailyUsageRemaps: [], dnr: [{ id: 21 }, { id: 22 }] };
  const after = structuredClone(before);
  after.ruleLists[1].name = 'Cold Study'; after.ruleListRevisions['list-1'] = 'renamed-revision';
  const responses = {
    pro: { isPro: true },
    schedule: { success: true, config: { enabled: false, days: [1, 3, 5], startTime: '11:37', durationMinutes: 5 },
      revision: 7, hasAccess: true, next: null, skipped: null },
    rename: { success: true, rules: before.rules, ruleLists: after.ruleLists, activeRuleListId: 'general', list: after.ruleLists[1] },
    'stale-generation': { success: false, error: { code: 'rules_state_changed' } },
    'stale-revision': { success: false, error: { code: 'rules_state_changed' } }
  };
  const packet = { errors: [], triggerAt: 31_000, completedAt: 31_100,
    sent: Object.keys(responses).map((id, index) => ({ id, at: 31_010 + index })),
    replies: Object.entries(responses).map(([id, response]) => ({ id, response, error: null, sentAt: 31_010, repliedAt: 31_020 })) };
  return { before, after, packet };
}

test('first-reply proof accepts reordered native responses with the exact preserved cold state', () => {
  const { before, after, packet } = proof();
  packet.replies.reverse();
  assertColdReplies(packet, before, 60_000); assertColdState(after, before);
});

test('first-reply proof rejects defaults, stale data and transport errors despite a correct final state', () => {
  for (const change of [
    packet => { packet.replies[0].response.isPro = false; },
    packet => { packet.replies[1].response.revision = 0; },
    packet => { packet.replies[2].response.rules = []; },
    packet => { packet.replies[0].error = 'message port closed'; },
    packet => { packet.replies[0].response = null; }
  ]) {
    const { before, after, packet } = proof();
    assertColdState(after, before); change(packet);
    assert.throws(() => assertColdReplies(packet, before, 60_000));
  }
});

test('first-reply proof rejects accepted stale generation/revision and a retry that later succeeds', () => {
  for (const change of [
    packet => { packet.replies[3].response = { success: true }; },
    packet => { packet.replies[4].response = { success: true }; },
    packet => { packet.replies.push(structuredClone(packet.replies[0])); },
    packet => { packet.sent.push(structuredClone(packet.sent[0])); },
    packet => { packet.errors.push('Duplicate first reply'); }
  ]) {
    const { before, packet } = proof(); change(packet);
    assert.throws(() => assertColdReplies(packet, before, 60_000));
  }
});

test('first-reply proof cannot credit an alarm wake or a delayed warm request burst', () => {
  const { before, packet } = proof();
  assert.throws(() => assertColdReplies(packet, before, packet.completedAt), /precede every native alarm/);
  packet.sent[4].at += 200; packet.completedAt += 200;
  assert.throws(() => assertColdReplies(packet, before, 60_000), /same early burst/);
});

test('cold-state proof rejects lost Focus, budget, generation, DNR and unrelated revisions', () => {
  for (const change of [
    state => { state.focusSession.focusActive = false; },
    state => { state.dailyRuleUsage.usageSeconds = {}; },
    state => { state.rulesGeneration = null; },
    state => { state.ruleRevisions[21] = null; },
    state => { state.dnr = []; },
    state => { state.ruleListRevisions['list-2'] = 'unexpected-revision'; },
    state => { state.pendingDailyUsageRemaps = [{ oldRuleId: 21 }]; }
  ]) {
    const { before, after } = proof(); change(after);
    assert.throws(() => assertColdState(after, before));
  }
});
