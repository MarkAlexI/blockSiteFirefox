import test from 'node:test';
import assert from 'node:assert/strict';
import { audioFixture } from './helpers/soundFixture.js';
import { createSoundGate, FOCUS_COMPLETE_SOUND, playFocusChime } from '../utils/soundPlayer.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  const timers = new Map(); let next = 0;
  return { timers, setTimer(fn) { timers.set(++next, fn); return next; }, clearTimer(id) { timers.delete(id); },
    fire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}

test('chime schedules two finite quiet notes and releases the actual connected graph', async () => {
  const f = audioFixture(), timer = clock();
  assert.deepEqual(await playFocusChime({ AudioContextCtor: f.AudioContext, ...timer }), { success: true });
  assert.equal(f.contexts.length, 1);
  const context = f.contexts[0];
  assert.equal(context.closed, 1);
  assert.deepEqual(context.nodes.map(n => n.frequencyValue), [659.25, 880]);
  for (const node of context.nodes) {
    assert.equal(node.type, 'sine'); assert.ok(node.stopAt > node.startAt && node.stopAt - node.startAt < 1);
    assert.equal(node.target.target, context.destination);
    assert.deepEqual(node.target.envelope.map(e => e.value), [0, 0.14, 0.0001]);
    assert.ok(node.target.envelope.every(e => Number.isFinite(e.at)));
    assert.equal(node.disconnected, true); assert.equal(node.target.disconnected, true); assert.equal(node.onended, null);
  }
  assert.equal(timer.timers.size, 0);
});

test('missing Web Audio and a cancelled request allocate no context', async () => {
  assert.equal((await playFocusChime({ AudioContextCtor: null })).success, false);
  const f = audioFixture();
  assert.equal((await playFocusChime({ AudioContextCtor: f.AudioContext, canPlay: () => false })).success, false);
  assert.equal(f.contexts.length, 0);
});

test('autoplay denial closes the context and cannot leave a rejection unhandled', async () => {
  const f = audioFixture({ resume: () => Promise.reject(new Error('NotAllowedError')) });
  await assert.rejects(playFocusChime({ AudioContextCtor: f.AudioContext }), /NotAllowedError/);
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.contexts[0].nodes.length, 0);
});

test('a changed preference during resume prevents both oscillators', async () => {
  const gate = deferred(); let enabled = true;
  const f = audioFixture({ resume: () => gate.promise });
  const playing = playFocusChime({ AudioContextCtor: f.AudioContext, canPlay: () => enabled });
  await tick(); enabled = false; gate.resolve();
  assert.equal((await playing).success, false);
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.contexts[0].nodes.length, 0);
});

for (const failAt of [0, 1]) test(`partial graph failure at oscillator ${failAt} releases preceding nodes`, async () => {
  const f = audioFixture({ failAt });
  await assert.rejects(playFocusChime({ AudioContextCtor: f.AudioContext }), /audio device/);
  assert.equal(f.contexts[0].closed, 1);
  assert.ok(f.contexts[0].nodes.every(n => n.disconnected && n.target.disconnected));
});

for (const phase of ['resume', 'ended']) test(`a stalled ${phase} is bounded and releases audio resources`, async () => {
  const timer = clock(), never = deferred();
  const f = audioFixture(phase === 'resume' ? { resume: () => never.promise } : { autoEnd: false });
  const work = playFocusChime({ AudioContextCtor: f.AudioContext, ...timer });
  await tick(); timer.fire();
  await assert.rejects(work, /timed out/);
  assert.equal(f.contexts[0].closed, 1); assert.ok(f.contexts[0].nodes.every(n => n.disconnected));
  never.resolve(); await tick(); assert.equal(f.contexts[0].state, 'closed');
});

test('concurrent requests share one owner; a duplicate never plays again', async () => {
  const gate = deferred(); let calls = 0;
  const play = createSoundGate(async () => { calls++; await gate.promise; return { success: true }; });
  const a = play(FOCUS_COMPLETE_SOUND, 'focus:1'), b = play(FOCUS_COMPLETE_SOUND, 'focus:1');
  assert.equal(a, b); await tick(); assert.equal(calls, 1); gate.resolve(); await a;
  assert.equal((await play(FOCUS_COMPLETE_SOUND, 'focus:1')).duplicate, true); assert.equal(calls, 1);
  await play(FOCUS_COMPLETE_SOUND, 'focus:2'); assert.equal(calls, 2);
});

test('timeout keeps ownership through late cleanup and never turns into delayed playback', async () => {
  const timer = clock(), preparation = deferred(); let calls = 0, played = 0, cleaned = 0;
  const play = createSoundGate(async (_sound, _id, canPlay) => {
    calls++; await preparation.promise;
    if (await canPlay()) played++;
    cleaned++; return { success: true };
  }, timer);
  const first = play(FOCUS_COMPLETE_SOUND, 'focus:1'); await tick(); timer.fire();
  assert.equal((await first).code, 'audio_timeout');
  assert.equal(play(FOCUS_COMPLETE_SOUND, 'preview:1'), first);
  preparation.resolve(); await tick();
  assert.equal(played, 0); assert.equal(cleaned, 1); assert.equal(calls, 1);
  assert.equal((await play(FOCUS_COMPLETE_SOUND, 'focus:1')).success, false, 'failed duplicate cannot claim playback succeeded');
  await play(FOCUS_COMPLETE_SOUND, 'preview:2'); assert.equal(calls, 2); assert.equal(played, 1);
});

test('arbitrary sound URLs and malformed request IDs cannot invoke playback', async () => {
  let calls = 0; const play = createSoundGate(() => { calls++; });
  for (const [sound, id] of [['https://example.test/audio', '1'], [FOCUS_COMPLETE_SOUND, ''], [FOCUS_COMPLETE_SOUND, 'x'.repeat(161)], [null, 1]]) {
    assert.equal((await play(sound, id)).success, false);
  }
  assert.equal(calls, 0);
});
