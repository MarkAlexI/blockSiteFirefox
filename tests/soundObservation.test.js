import test from 'node:test';
import assert from 'node:assert/strict';
import { installSoundObservation, readSoundObservation } from '../e2e/sound-observation.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(run) {
  const saved = Object.fromEntries(['window', 'browser'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const resumed = deferred(), closed = deferred(), intervals = new Map(); let next = 0, now = 0;
  class AudioContext extends EventTarget {
    constructor() { super(); this.state = 'suspended'; this.currentTime = 0; }
    resume() { return resumed.promise; }
    close() { return closed.promise; }
    createOscillator() { return new EventTarget(); }
    createGain() { return { connections: [], connect(node) { this.connections.push(node); } }; }
    createAnalyser() { return { fftSize: 4, getFloatTimeDomainData(values) { values.fill(0.6); } }; }
  }
  const originals = Object.fromEntries(['resume', 'createGain', 'createOscillator', 'close'].map(name => [name, AudioContext.prototype[name]]));
  const view = { AudioContext, Float32Array, performance: { now: () => now },
    setInterval(fn) { intervals.set(++next, fn); return next; }, clearInterval(id) { intervals.delete(id); } };
  globalThis.window = {};
  globalThis.browser = { runtime: { getManifest: () => ({ background: { scripts: ['event-page.js'] } }),
    getBackgroundPage: async () => view } };
  try {
    await installSoundObservation();
    await run({ AudioContext, resumed, closed, intervals, originals, setNow(value) { now = value; } });
  } finally {
    window.__bdSoundObservation?.restore();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test('audio observation preserves native promises and nodes while recording resume, ended and closure', async () => fixture(async f => {
  const context = new f.AudioContext();
  assert.equal(context.resume(), f.resumed.promise, 'the original resume promise reaches production');
  f.setNow(2000); context.state = 'running'; f.resumed.resolve(); await tick();
  const gain = context.createGain(), destination = {};
  gain.connect(destination); assert.equal(gain.connections.at(-1), destination);
  const oscillator = context.createOscillator();
  for (const sample of f.intervals.values()) sample();
  f.setNow(2840); oscillator.dispatchEvent(new Event('ended'));
  assert.equal(context.close(), f.closed.promise, 'the original close promise reaches production');
  context.state = 'closed'; context.dispatchEvent(new Event('statechange'));
  f.closed.resolve(); await tick();
  const result = await readSoundObservation(), record = result.contexts[0];
  assert.equal(record.gains, 1); assert.equal(record.ended, 1); assert.equal(record.closed, true);
  assert.ok(record.peak > 0.59);
  assert.deepEqual(record.timeline.filter(item => item.stage.startsWith('resume')).map(item => [item.stage, item.at]),
    [['resume:begin', 0], ['resume:resolved', 2000]]);
  assert.deepEqual(result.errors, []); assert.equal(f.intervals.size, 0);
  window.__bdSoundObservation.restore();
  for (const [name, original] of Object.entries(f.originals)) assert.equal(f.AudioContext.prototype[name], original);
  const before = record.timeline.length; context.dispatchEvent(new Event('statechange'));
  assert.equal(record.timeline.length, before, 'restoration removes observation listeners');
}));

test('observation preserves native resume rejection and records its original stage', async () => fixture(async f => {
  const context = new f.AudioContext(), error = new Error('native resume denied');
  const promise = context.resume(); assert.equal(promise, f.resumed.promise);
  f.resumed.reject(error); await assert.rejects(promise, value => value === error); await tick();
  const state = await readSoundObservation();
  assert.equal(state.contexts[0].gains, 0);
  assert.deepEqual(state.errors, [{ stage: 'resume:rejected', name: 'Error', message: 'native resume denied' }]);
}));
