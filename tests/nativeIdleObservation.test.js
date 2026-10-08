import test from 'node:test';
import assert from 'node:assert/strict';
import { observeEventPageIdle } from '../e2e/native-idle.mjs';

function model(change = value => value) {
  let time = 0;
  const evidence = {};
  const options = { closedAt: 0, processId: 17, profile: '/native/profile', alarm: { name: 'end_focus_session', scheduledTime: 50_000 },
    competingAlarms: [{ name: 'update_scheduled_rules', scheduledTime: 60_000 }], evidence,
    now: () => time, pause: async ms => { time += ms; },
    read: async () => change({ at: time, processId: 17, profile: '/native/profile',
      state: time < 30_000 || time >= 50_000 ? 'running' : 'stopped',
      views: time < 30_000 || time >= 50_000 ? [{ type: 'background', unloaded: false }] : [],
      tabs: ['about:blank'], events: [
        ...(time >= 30_000 ? [{ at: 30_000, running: false }] : []),
        ...(time >= 50_000 ? [{ at: 50_000, running: true }] : [])] }) };
  return { options, evidence };
}

test('parent-state model requires an automatic unload, sustained absence and native alarm wake', async () => {
  const { options, evidence } = model();
  assert.equal(await observeEventPageIdle(options), evidence);
  assert.equal(evidence.idleAt, 30_000); assert.equal(evidence.wakeAt, 50_000);
});

test('parent-state model rejects a pinned event page without unload', async () => {
  const { options } = model(value => ({ ...value, state: 'running', views: [{ type: 'background' }], events: [] }));
  await assert.rejects(observeEventPageIdle(options), /never automatically unloaded/);
});

test('parent-state model rejects an early stop or early wake', async () => {
  const earlyStop = model(value => value.at < 30_000 ? value : {
    ...value, events: [{ at: 1000, running: false }] });
  await assert.rejects(observeEventPageIdle(earlyStop.options), /default idle interval/);
  const earlyWake = model(value => value.at < 40_000 ? value : {
    ...value, state: 'running', events: [{ at: 30_000, running: false }, { at: 40_000, running: true }] });
  await assert.rejects(observeEventPageIdle(earlyWake.options), /before the expected alarm/);
});

test('parent-state model rejects missing wake and competing alarm attribution', async () => {
  const missing = model(value => value.at < 30_000 ? value : { ...value, state: 'stopped', views: [],
    events: [{ at: 30_000, running: false }] });
  await assert.rejects(observeEventPageIdle(missing.options), /did not wake/);
  const late = model(value => value.at < 50_000 ? value : { ...value,
    events: [{ at: 30_000, running: false }, { at: 60_000, running: true }] });
  await assert.rejects(observeEventPageIdle(late.options), /competing native alarm/);
});

test('parent-state model rejects browser replacement, extension views and changed keeper', async () => {
  for (const [change, expected] of [
    [value => ({ ...value, processId: 18 }), /same native Firefox process/],
    [value => ({ ...value, profile: '/replacement/profile' }), /same native Firefox profile/],
    [value => ({ ...value, views: [{ type: 'tab' }] }), /view pins/],
    [value => ({ ...value, tabs: ['about:blank', 'moz-extension:\/\/test\/index.html'] }), /neutral keeper/]
  ]) await assert.rejects(observeEventPageIdle(model(change).options), expected);
});

test('parent-state model rejects observer gaps, duplicate cycles and short stopped intervals', async () => {
  for (const [change, expected] of [
    [value => ({ ...value, events: [] }), /never automatically unloaded/],
    [value => ({ ...value, events: [{ at: 30_000, running: false }, { at: 31_000, running: false }] }), /one native idle unload/],
    [value => value.at >= 30_000 && value.at < 50_000 ? { ...value, state: 'suspending' } : value, /sustained native stopped/]
  ]) await assert.rejects(observeEventPageIdle(model(change).options), expected);
});

test('parent-state model propagates observation errors and rejects an ambiguous alarm order', async () => {
  const { options } = model();
  await assert.rejects(observeEventPageIdle({ ...options, read: async () => { throw new Error('native observation failed'); } }),
    /native observation failed/);
  await assert.rejects(observeEventPageIdle({ ...options, competingAlarms: [{ scheduledTime: 45_000 }] }), /precedes every competing alarm/);
});
