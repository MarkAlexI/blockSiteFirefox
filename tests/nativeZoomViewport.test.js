import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setNativeZoomedViewport } from '../e2e/native-zoom-viewport.mjs';

function model({ scale = 1, forcedZoom, clamp = Infinity, widths = [], rejectResize = false, reportedState } = {}) {
  let width = 1280, height = 960, factor = 1, state = 'maximized', clock = 0, reads = 0;
  const updates = [], zooms = [];
  const nativeWindow = () => ({ width, height, state: reportedState ?? state });
  const api = {
    windows: {
      async update(_id, info) {
        updates.push(JSON.parse(JSON.stringify(info)));
        if (info.state) state = info.state;
        if (info.width !== undefined) {
          if (rejectResize) throw new Error('native resize refused');
          width = Math.min(info.width, clamp);
        }
        if (info.height !== undefined) height = info.height;
        return nativeWindow();
      },
      async get() { return nativeWindow(); }
    },
    tabs: {
      async setZoom(_id, value) { zooms.push(value); factor = forcedZoom ?? value; },
      async getZoom() { return factor; }
    }
  };
  const page = { async evaluate(fn, input) {
    const index = reads;
    const context = { browser: api, input, screen: { availWidth: 1280, availHeight: 1024 },
      innerWidth: widths[Math.min(index, widths.length - 1)] ?? Math.floor(width / (scale * factor)) - 1,
      innerHeight: Math.floor(height / (scale * factor)) - 60,
      outerWidth: width, outerHeight: height, devicePixelRatio: scale * factor };
    const result = await vm.runInNewContext('(' + fn.toString() + ')(input)', context);
    if (result?.innerWidth !== undefined) reads++;
    return result;
  } };
  const evidence = [];
  const run = () => setNativeZoomedViewport(page, { windowId: 1, tabId: 2 },
    { evidence, now: () => clock, wait: async ms => { clock += ms; } });
  return { run, evidence, updates, zooms };
}

test('native zoom viewport retains the original window when its real CSS width fits', async () => {
  const m = model();
  const result = await m.run();
  assert.equal(result.factor, 2);
  assert.equal(result.innerWidth, 319);
  assert.deepEqual(m.zooms, [2]);
  assert.deepEqual(m.updates, [{ state: 'normal' }, { width: 640, height: 960 }]);
});

test('native zoom viewport corrects the observed 255px setup with real window resizing', async () => {
  const m = model({ scale: 1.25 });
  const result = await m.run();
  assert.equal(m.evidence[0].innerWidth, 255);
  assert.equal(result.innerWidth, 320);
  assert.equal(result.factor, 2);
  assert.equal(result.dpr, 2.5);
  assert.deepEqual(m.updates, [{ state: 'normal' }, { width: 640, height: 960 }, { width: 803 }]);
  assert.deepEqual(m.zooms, [2]);
});

test('native zoom viewport uses measured geometry when the platform still reports maximized', async () => {
  const m = model({ reportedState: 'maximized', widths: [320, 320] });
  const result = await m.run();
  assert.equal(result.innerWidth, 320);
  assert.equal(result.factor, 2);
  assert.equal(result.dpr, 2);
  assert.equal(result.state, 'maximized');
  assert.deepEqual(m.updates, [{ state: 'normal' }, { width: 640, height: 960 }]);
  assert.deepEqual(m.zooms, [2]);

  const clamped = model({ reportedState: 'maximized', clamp: 500 });
  await assert.rejects(clamped.run(), /Native 200% narrow viewport not reached/);
  assert.equal(clamped.updates.filter(info => info.width !== undefined).length, 4);
});

test('native zoom viewport waits for stable measurements before correcting a transient width', async () => {
  const m = model({ widths: [255, 319, 319] });
  assert.equal((await m.run()).innerWidth, 319);
  assert.equal(m.updates.length, 2);
});

test('native zoom viewport rejects clamped windows and bounds native resize attempts', async () => {
  const m = model({ clamp: 500 });
  await assert.rejects(m.run(), /Native 200% narrow viewport not reached/);
  assert.equal(m.updates.filter(info => info.width !== undefined).length, 4);
  assert.ok(m.evidence.every(row => row.innerWidth === 249));
  assert.deepEqual(m.zooms, [2]);
});

test('native zoom viewport requires actual 200 percent zoom even when CSS width fits', async () => {
  const m = model({ forcedZoom: 2.5, scale: 0.8 });
  await assert.rejects(m.run(), /Native 200% narrow viewport not reached/);
  assert.equal(m.evidence.at(-1).factor, 2.5);
  assert.equal(m.evidence.at(-1).innerWidth, 319);
  assert.equal(m.updates.length, 2);
});

test('native zoom viewport propagates native resize failures', async () => {
  const m = model({ rejectResize: true });
  await assert.rejects(m.run(), /native resize refused/);
});
