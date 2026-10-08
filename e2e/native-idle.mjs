import assert from 'node:assert/strict';

// The read function must observe parent-process state only. A native idle cycle
// must have a full stopped interval and its first wake must fit the expected
// alarm, before any competing alarm. Model tests inject only read/clock/wait.
export async function observeEventPageIdle({ read, closedAt, processId, profile, alarm, competingAlarms,
  now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), evidence = {} }) {
  const competitor = competingAlarms.length ? Math.min(...competingAlarms.map(item => item.scheduledTime)) : Infinity;
  assert.ok(alarm.scheduledTime - closedAt > 45_000, 'expected alarm leaves time for native idle unload');
  assert.ok(competitor > alarm.scheduledTime, 'expected alarm precedes every competing alarm');
  Object.assign(evidence, { closedAt, alarm, competingAlarms, samples: [] });
  let stoppedAt = null;
  const deadline = Math.min(alarm.scheduledTime + 20_000, competitor);
  while (now() < deadline) {
    const sample = await read();
    evidence.samples.push({ at: sample.at, state: sample.state, views: sample.views });
    evidence.events = sample.events;
    assert.equal(sample.processId, processId, 'same native Firefox process across idle/wake');
    assert.equal(sample.profile, profile, 'same native Firefox profile across idle/wake');
    assert.deepEqual(sample.tabs, ['about:blank'], 'only the same neutral keeper remains');
    assert.ok(['running', 'suspending', 'stopped', 'starting'].includes(sample.state), 'known native background state');
    assert.ok(sample.views.every(view => view.type === 'background'), 'no UI/extension view pins the event page');
    const stops = sample.events.filter(event => event.running === false);
    const wakes = sample.events.filter(event => event.running === true);
    assert.ok(stops.length <= 1 && wakes.length <= 1, 'one native idle unload and one wake');
    if (stops.length) {
      stoppedAt = stops[0].at;
      evidence.idleAt = stoppedAt;
      assert.ok(stoppedAt - closedAt >= 25_000, 'native unload follows the default idle interval');
      assert.ok(stoppedAt - closedAt < 45_000, 'event page unloads within the native idle window');
    }
    if (!stoppedAt) assert.ok(sample.at - closedAt < 45_000, 'event page never automatically unloaded');
    if (sample.state === 'stopped' && sample.views.length === 0) evidence.lastStoppedAt = sample.at;
    if (wakes.length || (stoppedAt && ['starting', 'running'].includes(sample.state))) {
      const wakeAt = wakes[0]?.at ?? sample.at;
      assert.ok(stoppedAt !== null && evidence.lastStoppedAt - stoppedAt >= 1000, 'sustained native stopped state was observed');
      assert.ok(wakeAt >= alarm.scheduledTime, 'no event wakes the event page before the expected alarm');
      assert.ok(wakeAt < competitor, 'wake precedes the competing native alarm');
      if (sample.state === 'running' && wakes.length === 1) {
        evidence.wakeAt = wakes[0].at;
        return evidence;
      }
    }
    await pause(200);
  }
  assert.fail('event page did not wake for the expected native alarm before the deadline');
}
