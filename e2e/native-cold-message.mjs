import assert from 'node:assert/strict';

// Parent observations do not attach to the event page or call its APIs.
// Return while it is still stopped; the caller's content script is the next
// permitted wake source. No terminateBackground/reload or idle-pref override.
export async function observeColdEventPage({ read, closedAt, processId, profile, producerUrl, earliestAlarm,
  now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), evidence }) {
  assert.ok(earliestAlarm - closedAt > 45_000, 'native alarms leave time for idle and first messages');
  evidence.closedAt = closedAt; evidence.earliestAlarm = earliestAlarm; evidence.samples = [];
  while (now() - closedAt < 45_000) {
    const sample = await read();
    evidence.samples.push(sample);
    assert.equal(sample.processId, processId, 'same native Firefox process');
    assert.equal(sample.profile, profile, 'same native Firefox profile');
    assert.deepEqual(sample.tabs, [producerUrl], 'only the content producer remains');
    assert.ok(sample.views.every(view => view.type === 'background'), 'no extension UI pins the event page');
    assert.ok(['running', 'suspending', 'stopped'].includes(sample.state), 'no unexpected cold wake');
    const stops = sample.events.filter(event => event.running === false);
    assert.equal(sample.events.filter(event => event.running === true).length, 0, 'no wake before the first content message');
    assert.ok(stops.length <= 1, 'one native idle unload');
    assert.ok(sample.at < earliestAlarm - 15_000, 'first-message deadline precedes every native alarm');
    if (stops.length) {
      evidence.idleAt = stops[0].at;
      assert.ok(evidence.idleAt - closedAt >= 25_000, 'default native idle interval');
      if (sample.state === 'stopped' && sample.views.length === 0 && sample.at - evidence.idleAt >= 1000) return sample;
    }
    await pause(200);
  }
  assert.fail('event page never automatically unloaded before the first-message window');
}

export function assertMessageWake(sample, evidence, packet) {
  assert.equal(sample.processId, evidence.processId);
  assert.equal(sample.profile, evidence.profile);
  assert.equal(sample.state, 'running', 'content messages woke the native event page');
  const wakes = sample.events.filter(event => event.running === true);
  assert.equal(wakes.length, 1, 'one first native message wake');
  assert.ok(wakes[0].at >= packet.triggerAt && wakes[0].at <= packet.completedAt,
    'native wake falls inside the first content-message burst');
  assert.ok(packet.triggerAt - evidence.idleAt >= 1000, 'sustained stopped interval before the content request');
}

export function assertMessageActivity(observation, { extensionId, producerUrl, token, requests, activityMarker }, packet) {
  assert.deepEqual(observation.errors, [], 'native cold activity did not lose history');
  assert.ok(Number.isInteger(activityMarker) && activityMarker >= 0, 'known native cold history boundary');
  const history = observation.events.filter(event => event.sequence > activityMarker);
  const messages = history.filter(event => event.type === 'message' && event.sender?.url === producerUrl);
  assert.equal(messages.length, 5, 'exactly five native callbacks from the original content producer');
  const expected = new Map(requests.map(request => [request.id, request.message]));
  assert.equal(expected.size, 5, 'five distinct expected content requests');
  assert.deepEqual(messages.map(event => event.payload?.__bdColdRequest).sort(), [...expected.keys()].sort(),
    'each original request has one native callback');
  for (const event of messages) {
    assert.equal(event.extensionId, extensionId, 'native receiving extension');
    assert.equal(event.viewType, 'background', 'native background callback');
    assert.equal(event.sender.id, extensionId, 'native sender extension');
    assert.equal(event.sender.frameId, 0, 'native main-frame content sender');
    assert.equal(event.payload.__bdColdToken, token, 'native callback belongs to this cold burst');
    assert.deepEqual(event.payload, expected.get(event.payload.__bdColdRequest), 'exact native request payload');
    const sent = packet.sent.find(request => request.id === event.payload.__bdColdRequest);
    assert.ok(sent && Number.isFinite(event.at) && event.at >= sent.at && event.at <= packet.completedAt,
      'native callback timestamp falls inside its first request/reply interval');
  }
  const alarms = history.filter(event => event.type === 'alarm' && event.at <= packet.completedAt);
  assert.deepEqual(alarms, [], 'no native alarm competes with the first content-message wake');
  return { messages, alarms };
}
