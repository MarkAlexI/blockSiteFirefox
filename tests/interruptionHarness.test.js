import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function method() {
  const source = await readFile(new URL('../e2e/fixtures.mjs', import.meta.url), 'utf8');
  const body = source.match(/  async interruptAndRestart\(\) \{([\s\S]*?)\n  \}\n/);
  assert.ok(body, 'actual harness interruption method');
  return body[1];
}
const expect = actual => ({ toBe: expected => assert.equal(actual, expected),
  not: { toBe: expected => assert.notEqual(actual, expected) } });

test('the actual harness kills its owned process, retains failure evidence and restarts without reseeding', async () => {
  const calls = [];
  let state;
  const interruptProfileBrowser = async input => { calls.push('kill'); assert.equal(input.profile, state.profile);
    return { signal: 'SIGKILL', pid: input.pid }; };
  const run = vm.runInNewContext(`(async function() {${await method()}\n})`, {
    interruptProfileBrowser, expect, assert, EnvironmentError: Error
  });
  if ((await readFile(new URL('../e2e/fixtures.mjs', import.meta.url), 'utf8')).includes('class ExtensionHarness')) {
    // Both variants use the same test; select the API by the method's native
    // ownership contract rather than importing the browser automation package.
    const chromium = (await method()).includes('this.nativeOwner');
    if (chromium) {
      const owner = { diagnostics: async () => ({ pid: 700 }), waitForExit: async () => {
        calls.push('prove-signal-exit'); return { signalCode: 'SIGKILL' };
      } };
      state = { profile: '/tmp/owned-interruption', nativeOwner: owner, installed: true, startupInstallation: {},
        saveTrace: async () => { calls.push('trace'); },
        async launch() { calls.push('launch'); assert.equal(this.worker, null); assert.equal(this.options.length, 0);
          this.nativeOwner = { diagnostics: async () => ({ pid: 701 }) }; }, seed() { assert.fail('never reseed'); } };
      const result = await run.call(state);
      assert.deepEqual(calls, ['trace', 'kill', 'prove-signal-exit', 'launch']);
      assert.equal(result.afterPid, 701); assert.equal(result.beforePid, 700);
    } else {
      state = { profile: '/tmp/owned-interruption', config: { installation: 'persistent' }, sessionReady: true,
        result: { browser: { 'moz:processID': 700 } }, driver: { quit() { assert.fail('never graceful quit'); } },
        bidi: { close: async () => { calls.push('close-bidi'); } }, service: { kill: async () => { calls.push('close-driver'); } },
        async launch(options) { calls.push('launch'); assert.equal(options.restarted, true);
          assert.equal(this.driver, null); this.result.browser['moz:processID'] = 701; }, seed() { assert.fail('never reseed'); } };
      const result = await run.call(state);
      assert.deepEqual(calls, ['kill', 'close-bidi', 'close-driver', 'launch']);
      assert.equal(result.afterPid, 701); assert.equal(result.beforePid, 700);
    }
    assert.equal(state.interruptionEvidence.signal, 'SIGKILL');
  } else assert.fail('missing extension harness');
});

test('the actual harness refuses an unowned or nonpersistent browser before signaling', async () => {
  let killed = false;
  const run = vm.runInNewContext(`(async function() {${await method()}\n})`, {
    interruptProfileBrowser: async () => { killed = true; }, expect, assert, EnvironmentError: Error
  });
  await assert.rejects(run.call({ config: { installation: 'temporary' } }));
  assert.equal(killed, false);
});
