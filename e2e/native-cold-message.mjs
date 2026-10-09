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
