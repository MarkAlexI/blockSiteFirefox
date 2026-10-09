import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWindowPhase, assertWindowAccounting } from '../e2e/window-probes.mjs';

const usage = (timestamp, a, b, owner = '21:general') => ({ version: 2, date: '2026-10-09',
  usageSeconds: { '21:general': a, '22:general': b }, lastSample: { timestamp, assignmentKeys: [owner] } });
const phase = () => ({ before: { dailyRuleUsage: usage(1000, 40, 60) },
  after: { dailyRuleUsage: usage(3400, 42, 60), pendingDailyUsageRemaps: [] },
  events: [{ kind: 'usage', value: usage(3300, 42, 60) }],
  owner: '21:general', inactive: '22:general', windowId: 7 });

test('native window oracle accepts positive foreground accounting and unchanged unfocused budget', () => {
  assert.deepEqual(assertWindowPhase(phase()), { gain: 2, elapsed: 2400, writes: 1 });
});

test('native window oracle rejects an inactive window charge even if the final total looks bounded', () => {
  const input = phase(); input.events[0].value.usageSeconds['22:general']++;
  assert.throws(() => assertWindowPhase(input), /unfocused window budget/);
});

test('native window oracle rejects a transient wrong owner followed by a correct final state', () => {
  const input = phase(); input.events.unshift({ kind: 'usage', value: usage(3100, 42, 60, '22:general') });
  assert.throws(() => assertWindowPhase(input), /steal the foreground segment/);
});

test('native window oracle requires actual foreground progress and native storage delivery', () => {
  const input = phase(); input.after.dailyRuleUsage.usageSeconds['21:general'] = 40;
  assert.throws(() => assertWindowPhase(input), /genuine foreground time/);
  const empty = phase(); empty.events = [];
  assert.throws(() => assertWindowPhase(empty), /observable durable samples/);
});

test('native window oracle rejects a duplicated charge and an unobserved focus precondition', () => {
  const input = phase(); input.after.dailyRuleUsage.usageSeconds['21:general'] = 44;
  assert.throws(() => assertWindowPhase(input), /duplicate charge/);
  const lost = phase(); lost.events.push({ kind: 'window-focus', windowId: -1 });
  assert.throws(() => assertWindowPhase(lost), /focus remained/);
});

test('native history oracle accepts serial foreground segments in two windows', () => {
  assertWindowAccounting([
    { kind: 'usage', value: usage(1000, 40, 60) },
    { kind: 'usage', value: usage(3400, 42, 60, '22:general') },
    { kind: 'usage', value: usage(5800, 42, 62) }
  ], { '21:general': 40, '22:general': 60 });
});

test('native history oracle rejects simultaneous spending that fits each separate window interval', () => {
  assert.throws(() => assertWindowAccounting([
    { kind: 'usage', value: usage(1000, 40, 60) },
    { kind: 'usage', value: usage(3400, 42, 62) }
  ], { '21:general': 40, '22:general': 60 }), /one elapsed timeline/);
});

test('native history oracle rejects budget erasure during a tab move', () => {
  assert.throws(() => assertWindowAccounting([
    { kind: 'usage', value: usage(1000, 40, 60) },
    { kind: 'usage', value: usage(3400, 0, 60) }
  ], { '21:general': 40, '22:general': 60 }), /never erase/);
});
