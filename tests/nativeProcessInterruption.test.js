import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptProfileBrowser } from '../e2e/native-process-interruption.mjs';

const request = { pid: 876543, profile: '/tmp/bd-owned-profile' };
const live = (started = '12345', args = ['chromium', '--user-data-dir=' + request.profile]) => ({ args, started, state: 'S' });

test('process interruption accepts only the exact owned Chromium or Firefox profile and proves exit', async () => {
  for (const args of [['chromium', '--user-data-dir=' + request.profile], ['firefox', '--profile', request.profile]]) {
    const records = [live('1', args), live('1', args), { ...live('1', args), state: 'Z' }];
    const signals = [];
    const result = await interruptProfileBrowser(request, { read: async () => records.shift(),
      platform: 'linux', signal: (...args) => signals.push(args) });
    assert.deepEqual(signals, [[request.pid, 'SIGKILL']]);
    assert.equal(result.signal, 'SIGKILL'); assert.equal(result.processStarted, '1');
  }
});

test('wrong profiles, missing processes, privileged PIDs and reused PIDs are rejected before signaling', async () => {
  const cases = [
    [{ ...request, pid: 1 }, [live()]], [{ ...request, pid: process.pid }, [live()]],
    [request, [null]], [request, [live('1', ['chromium', '--user-data-dir=' + request.profile + '-other'])]],
    [request, [live('1'), live('2')]], [request, [live('1'), live('1', ['firefox', '--profile', '/tmp/another'])]]
  ];
  for (const [input, records] of cases) {
    let signaled = false;
    await assert.rejects(interruptProfileBrowser(input, { platform: 'linux',
      read: async () => records.shift(), signal: () => { signaled = true; } }));
    assert.equal(signaled, false);
  }
});

test('an accepted signal is not mistaken for proof that the process exited', async () => {
  let time = 0, calls = 0;
  await assert.rejects(interruptProfileBrowser(request, { platform: 'linux', read: async () => live(),
    signal: () => { calls++; }, now: () => time, pause: async ms => { time += ms; }, timeout: 30 }), /process exited/);
  assert.equal(calls, 1);
});
