import test from 'node:test';
import assert from 'node:assert/strict';
import { observeColdEventPage, assertMessageWake, assertMessageActivity } from '../e2e/native-cold-message.mjs';
import { coldRequests } from '../e2e/cold-message.mjs';

function model(change = value => value) {
  let at = 0;
  const evidence = { processId: 17, profile: '/native/profile' };
  const config = { closedAt: 0, processId: 17, profile: '/native/profile', producerUrl: 'http://cold.bd-e2e.test/',
    earliestAlarm: 60_000, evidence, now: () => at, pause: async ms => { at += ms; },
    read: async () => change({ at, processId: 17, profile: '/native/profile',
      tabs: ['http://cold.bd-e2e.test/'], state: at < 30_000 ? 'running' : 'stopped',
      views: at < 30_000 ? [{ type: 'background' }] : [],
      events: at < 30_000 ? [] : [{ at: 30_000, running: false }] }) };
  return { config, evidence };
}

test('parent cold-message model returns while the native event page is still stopped', async () => {
  const { config, evidence } = model();
  const sample = await observeColdEventPage(config);
  assert.equal(sample.state, 'stopped'); assert.equal(sample.at, 31_000); assert.equal(evidence.idleAt, 30_000);
  assert.equal(sample.events.some(event => event.running), false);
});

test('parent cold-message model rejects a pinned event page or premature automatic wake', async () => {
  await assert.rejects(observeColdEventPage(model(value => ({ ...value, state: 'running', events: [] })).config), /never automatically unloaded/);
  await assert.rejects(observeColdEventPage(model(value => value.at < 30_000 ? value : { ...value,
    state: 'running', events: [...value.events, { at: 30_500, running: true }] }).config), /no wake before/);
});

test('parent cold-message model rejects early unload, UI views and browser replacement', async () => {
  for (const [change, expected] of [
    [value => ({ ...value, processId: 18 }), /same native Firefox process/],
    [value => ({ ...value, profile: '/replacement' }), /same native Firefox profile/],
    [value => ({ ...value, tabs: ['about:blank'] }), /content producer/],
    [value => ({ ...value, views: [{ type: 'popup' }] }), /UI pins/],
    [value => value.at < 30_000 ? value : { ...value, events: [{ at: 1000, running: false }] }, /default native idle/]
  ]) await assert.rejects(observeColdEventPage(model(change).config), expected);
});

test('parent cold-message model requires the first-reply window before every alarm and propagates native errors', async () => {
  await assert.rejects(observeColdEventPage({ ...model().config, earliestAlarm: 40_000 }), /leave time/);
  await assert.rejects(observeColdEventPage(model(value => ({ ...value, at: 50_000 })).config), /deadline precedes/);
  await assert.rejects(observeColdEventPage({ ...model().config, read: async () => { throw new Error('observer lost'); } }), /observer lost/);
});

test('parent wake evidence requires exactly one native wake during the first-message burst', () => {
  const evidence = { processId: 17, profile: '/native/profile', idleAt: 30_000 };
  const packet = { triggerAt: 31_200, completedAt: 31_900 };
  const sample = { processId: 17, profile: '/native/profile', state: 'running', events: [{ at: 31_300, running: true }] };
  assertMessageWake(sample, evidence, packet);
  for (const events of [[], [{ at: 31_000, running: true }], [{ at: 32_000, running: true }],
    [{ at: 31_300, running: true }, { at: 31_500, running: true }]]) {
    assert.throws(() => assertMessageWake({ ...sample, events }, evidence, packet));
  }
});

function activityModel() {
  const evidence = { extensionId: 'native-addon@test', producerUrl: 'http://cold.bd-e2e.test/producer',
    token: 'cold-token', activityMarker: 10 };
  evidence.requests = coldRequests({ rulesGeneration: 'generation',
    ruleListRevisions: { 'list-1': 'study-revision', 'list-2': 'work-revision' } }, evidence.token);
  const packet = { completedAt: 31_900, sent: evidence.requests.map(request =>
    ({ id: request.id, at: 31_200 })) };
  const observation = { errors: [], events: evidence.requests.map((request, i) => ({ sequence: 11 + i,
    at: 31_300 + i, receivedAt: 40_000, type: 'message', extensionId: evidence.extensionId, viewType: 'background',
    payload: structuredClone(request.message), sender: { id: evidence.extensionId, url: evidence.producerUrl, frameId: 0 } })) };
  return { evidence, packet, observation };
}

test('Firefox native activity model uses five exact payload/sender callbacks and native source timestamps', () => {
  const { evidence, packet, observation } = activityModel();
  observation.events.unshift({ sequence: 10, at: 30_000, type: 'alarm', alarm: { name: 'warm-minute' } });
  observation.events.push({ sequence: 16, at: 32_000, type: 'alarm', alarm: { name: 'later-minute' } });
  const result = assertMessageActivity(observation, evidence, packet);
  assert.equal(result.messages.length, 5); assert.deepEqual(result.alarms, []);
});

test('Firefox native activity model rejects missing, duplicate, unrelated or altered cold message callbacks', () => {
  for (const change of [
    value => value.events.pop(), value => value.events.push(structuredClone(value.events[0])),
    value => { value.events[0].payload.__bdColdRequest = value.events[1].payload.__bdColdRequest; },
    value => { value.events[0].payload.__bdColdToken = 'another-cycle'; },
    value => { value.events[0].payload.type = 'wrong-intent'; },
    value => { value.events[0].extensionId = 'another-addon@test'; },
    value => { value.events[0].sender.id = 'another-addon@test'; },
    value => { value.events[0].sender.url += '?replacement'; },
    value => { value.events[0].sender.frameId = 1; },
    value => { value.events[0].viewType = 'popup'; },
    value => { value.events[0].sequence = 10; },
    value => { value.events[0].at = 31_199; }, value => { value.events[0].at = 31_901; }
  ]) {
    const { evidence, packet, observation } = activityModel(); change(observation);
    assert.throws(() => assertMessageActivity(observation, evidence, packet), assert.AssertionError);
  }
});

test('Firefox native activity model rejects competing alarms, observation loss and missing history boundaries', () => {
  for (const change of [
    value => { value.observation.events.push({ sequence: 16, at: 31_250, type: 'alarm', alarm: { name: 'update_scheduled_rules' } }); },
    value => { value.observation.errors.push('lost native event'); },
    value => { value.evidence.activityMarker = null; }
  ]) {
    const value = activityModel(); change(value);
    assert.throws(() => assertMessageActivity(value.observation, value.evidence, value.packet), assert.AssertionError);
  }
});
