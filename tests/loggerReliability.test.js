import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../utils/logger.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function loadLogger(options = {}) {
  const settings = Object.hasOwn(options, 'settings') ? options.settings : { debugMode: false, mode: 'strict' };
  const { read } = options;
  const data = settings === undefined ? {} : { settings: structuredClone(settings) };
  const listeners = [], writes = [], calls = [];
  let readSettings = read || (() => structuredClone(data));
  let writeSettings = values => {
    const oldValue = data.settings;
    Object.assign(data, structuredClone(values));
    listeners.forEach(listener => listener({
      settings: { oldValue, newValue: structuredClone(data.settings) }
    }, 'sync'));
  };
  const api = {
    storage: {
      sync: {
        get(_keys, callback) {
          const value = readSettings();
          if (typeof callback === 'function') {
            if (value?.then) return value.then(callback, () => callback(undefined));
            callback(value);
            return;
          }
          return Promise.resolve(value);
        },
        async set(values) {
          writes.push(structuredClone(values));
          await writeSettings(values);
        }
      },
      onChanged: { addListener(listener) { listeners.push(listener); } }
    }
  };
  const consoleRef = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'group', 'groupEnd']
      .map(name => [name, (...values) => calls.push({ name, values })])
  );
  const context = vm.createContext({ browser: api, chrome: api, console: consoleRef });
  vm.runInContext(source.replace('export default Logger;', 'globalThis.Logger = Logger;'), context,
    { filename: 'utils/logger.js' });
  await tick();
  return {
    controller: context.DebugController,
    logger: new context.Logger('Reliability'),
    data, writes, calls,
    setRead(value) { readSettings = value; },
    setWrite(value) { writeSettings = value; },
    change(value, namespace = 'sync') {
      listeners.forEach(listener => listener({ settings: { newValue: value } }, namespace));
    }
  };
}

for (const [label, value] of [['undefined', undefined], ['null', null], ['array', []], ['scalar', 42]]) {
  test(`logger initialization tolerates ${label} in place of a storage result`, async () => {
    const h = await loadLogger({ read: () => value });
    assert.equal(h.controller.status(), false);
    h.logger.log('hidden');
    h.logger.error('still available');
    assert.deepEqual(h.calls.map(call => call.name), ['error']);
    assert.equal(h.calls[0].values.at(-1), 'still available');
    assert.equal(h.writes.length, 0);
  });
}

for (const kind of ['throw', 'reject']) {
  test(`logger initialization absorbs a storage ${kind} without disabling error logging`, async () => {
    const h = await loadLogger({ read: () => {
      const error = new Error('synthetic storage refusal');
      if (kind === 'throw') throw error;
      return Promise.reject(error);
    } });
    assert.equal(h.controller.status(), false);
    h.logger.error('visible');
    assert.equal(h.calls.at(-1).name, 'error');
    assert.equal(h.writes.length, 0);
  });
}

for (const [label, read] of [
  ['undefined result', () => undefined],
  ['null result', () => null],
  ['rejected read', () => Promise.reject(new Error('read refused'))],
  ['throwing read', () => { throw new Error('read refused'); }],
  ['malformed result', () => []],
  ['malformed settings', () => ({ settings: [] })]
]) {
  test(`both debug controls preserve saved settings after ${label}`, async () => {
    const h = await loadLogger({ settings: { debugMode: true, mode: 'strict', nested: { sound: false } } });
    const before = structuredClone(h.data);
    h.setRead(read);
    assert.equal(await h.controller.disable(), false);
    assert.equal(await h.controller.enable(), false);
    assert.deepEqual(h.data, before);
    assert.equal(h.controller.status(), true);
    assert.equal(h.writes.length, 0);
  });
}

test('successful debug controls preserve all unrelated settings and report committed choices', async () => {
  const h = await loadLogger({ settings: { debugMode: false, mode: 'strict', nested: { sound: false } } });
  assert.equal(await h.controller.enable(), true);
  assert.deepEqual(h.data.settings, { debugMode: true, mode: 'strict', nested: { sound: false } });
  assert.equal(h.controller.status(), true);
  assert.equal(await h.controller.disable(), true);
  assert.deepEqual(h.data.settings, { debugMode: false, mode: 'strict', nested: { sound: false } });
  assert.equal(h.controller.status(), false);
});

test('a successful empty read can create a debug preference', async () => {
  const h = await loadLogger({ settings: undefined });
  assert.equal(h.controller.status(), false);
  assert.equal(await h.controller.enable(), true);
  assert.deepEqual(h.data.settings, { debugMode: true });
});

test('a rejected settings write preserves state and a later explicit retry can succeed', async () => {
  const h = await loadLogger({ settings: { debugMode: true, mode: 'strict' } });
  h.setWrite(() => Promise.reject(new Error('write refused')));
  assert.equal(await h.controller.disable(), false);
  assert.deepEqual(h.data.settings, { debugMode: true, mode: 'strict' });
  assert.equal(h.controller.status(), true);
  h.setWrite(values => {
    Object.assign(h.data, structuredClone(values));
    h.change(h.data.settings);
  });
  assert.equal(await h.controller.disable(), true);
  assert.deepEqual(h.data.settings, { debugMode: false, mode: 'strict' });
  assert.equal(h.controller.status(), false);
});

test('a synchronously throwing settings write is contained', async () => {
  const h = await loadLogger();
  h.setWrite(() => { throw new Error('write refused'); });
  assert.equal(await h.controller.enable(), false);
  assert.deepEqual(h.data.settings, { debugMode: false, mode: 'strict' });
  assert.equal(h.controller.status(), false);
});

for (const [label, value] of [
  ['deleted settings', undefined], ['null settings', null], ['array settings', []],
  ['missing debug flag', {}], ['string debug flag', { debugMode: 'true' }]
]) {
  test(`${label} turn off previously enabled debug logging`, async () => {
    const h = await loadLogger({ settings: { debugMode: true } });
    assert.equal(h.controller.status(), true);
    h.change(value);
    assert.equal(h.controller.status(), false);
    const before = h.calls.length;
    h.logger.log('hidden after reset');
    assert.equal(h.calls.length, before);
  });
}

test('initial settings only enable debug for the boolean true', async () => {
  for (const settings of [null, [], {}, { debugMode: 'true' }, { debugMode: 1 }]) {
    const h = await loadLogger({ settings });
    assert.equal(h.controller.status(), false);
  }
});

for (const newer of [false, true]) {
  test(`a delayed initial read cannot undo a newer debug=${newer} storage event`, async () => {
    let resolve;
    const initial = new Promise(fulfill => { resolve = fulfill; });
    const h = await loadLogger({ read: () => initial });
    h.change({ debugMode: newer });
    resolve({ settings: { debugMode: !newer } });
    await tick();
    assert.equal(h.controller.status(), newer);
  });
}

test('a late initial read rejection preserves a newer enabled setting', async () => {
  let reject;
  const initial = new Promise((_resolve, fail) => { reject = fail; });
  const h = await loadLogger({ read: () => initial });
  h.change({ debugMode: true });
  reject(new Error('late read refusal'));
  await tick();
  assert.equal(h.controller.status(), true);
});
