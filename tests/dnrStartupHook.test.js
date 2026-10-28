import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

// Execute the actual harness methods without importing Selenium into the root
// unit-test job. These API models prove ordering, not native browser readiness.
const source = readFileSync(new URL('../e2e/fixtures.mjs', import.meta.url), 'utf8');
const method = (name, next) => source.slice(source.indexOf(`  async ${name}(`), source.indexOf(`\n  async ${next}(`));

test('actual Firefox launch waits for the DNR observer before opening extension UI or reading startup storage', async () => {
  const events = [];
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const capabilities = new Map([['webSocketUrl', 'ws://127.0.0.1:3003'], ['moz:processID', 123], ['acceptInsecureCerts', false]]);
  const driver = {
    getCapabilities: async () => capabilities,
    setContext: async () => {}, executeScript: async () => true,
    getBidi: async () => ({ on() {} }),
    getAllWindowHandles: async () => ['probe'],
    switchTo: () => ({ window: async () => {} }),
    installAddon: async () => { throw new Error('persistent restart must not reinstall'); }
  };
  class Options {
    enableBidi() { return this; } addArguments() { return this; } set() { return this; }
    setAcceptInsecureCerts() { return this; } setPreference() { return this; }
  }
  const harness = {
    config: { headless: true, installation: 'persistent', output: '/unused' }, result: {},
    profile: '/unused/profile', id: 'owned-addon', uuid: 'owned-uuid', baseUrl: 'moz-extension://owned-uuid',
    proxy: { port: 4000, ca: 'TEST CERT' }, command: async () => {},
    newPage: async () => {
      events.push('extension UI');
      return { context: 'probe', evaluate: async () => { events.push('extension read'); return reads++ === 0 ? 'owned-addon' : true; } };
    }
  };
  const launch = runInNewContext(`({${method('launch', 'newPage')}}).launch`, {
    assert, path, process: { env: {} }, Buffer, Date, URL,
    allocateLoopbackPorts: async () => [3001, 3002, 3003], assertLoopbackPortsAvailable: async () => {},
    firefox: { Options, Driver: { createSession: async () => driver }, Context: { CHROME: 'chrome', CONTENT: 'content' } },
    DriverService: class {}, open: async () => ({ fd: 1, close: async () => {} }),
    equalEventually: async (read, expected) => assert.equal(await read(), expected)
  });
  const running = launch.call(harness, { restarted: true, beforeExtensionProbe: async evidence => {
    assert.equal(evidence.processId, 123); assert.ok(Number.isFinite(evidence.launchedAt));
    events.push('DNR entered'); enter(); await held; events.push('DNR complete');
  } });
  assert.equal(await Promise.race([entered.then(() => true), running.then(() => false)]), true);
  assert.deepEqual(events, ['DNR entered']);
  release(); await running;
  assert.deepEqual(events, ['DNR entered', 'DNR complete', 'extension UI', 'extension read', 'extension read']);
});

test('actual Firefox restart forwards the pre-UI observer after normal quit and requires persistent installation', async () => {
  const events = [], observer = () => {};
  class EnvironmentError extends Error {}
  const restart = runInNewContext(`({${method('restart', 'capture')}}).restart`, { EnvironmentError });
  const harness = {
    config: { installation: 'persistent' }, capture: async () => events.push('capture before quit'),
    driver: { quit: async () => events.push('normal quit') },
    launch: async options => {
      events.push('new process'); assert.equal(options.restarted, true);
      assert.equal(options.beforeExtensionProbe, observer);
    }
  };
  await restart.call(harness, { beforeExtensionProbe: observer });
  assert.deepEqual(events, ['capture before quit', 'normal quit', 'new process']);
  harness.config.installation = 'temporary';
  await assert.rejects(restart.call(harness), /persistent/);
});
