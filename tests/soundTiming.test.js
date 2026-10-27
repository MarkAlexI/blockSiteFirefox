import test from 'node:test';
import assert from 'node:assert/strict';
import { audioFixture } from './helpers/soundFixture.js';
import { createSoundGate, FOCUS_COMPLETE_SOUND, playFocusChime } from '../utils/soundPlayer.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function timedAudio({ resumeMs = 0, ended = true } = {}) {
  let now = 0, next = 0;
  const timers = new Map();
  const clock = {
    setTimer(fn, ms) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(target) {
      for (;;) {
        const first = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!first || first[1].at > target) break;
        const [id, event] = first; now = event.at; timers.delete(id); event.fn(); await tick();
      }
      now = target; await tick();
    }
  };
  const fixture = audioFixture({ autoEnd: false, resume: () => new Promise(resolve => clock.setTimer(resolve, resumeMs)) });
  class AudioContext extends fixture.AudioContext {
    createOscillator() {
      const node = super.createOscillator(), stop = node.stop.bind(node);
      let endTimer;
      node.stop = at => {
        stop(at);
        clock.clearTimer(endTimer);
        if (at !== undefined && ended) endTimer = clock.setTimer(() => node.onended?.(),
          Math.round((at - this.currentTime) * 1000));
      };
      return node;
    }
  }
  const play = createSoundGate((_sound, _id, canPlay) =>
    playFocusChime({ AudioContextCtor: AudioContext, canPlay, ...clock }), clock);
  return { contexts: fixture.contexts, clock, play };
}

for (const resumeMs of [0, 2000, 2499]) test(`a ${resumeMs}ms resume leaves a full finite chime inside the request budget`, async () => {
  const f = timedAudio({ resumeMs });
  let result;
  f.play(FOCUS_COMPLETE_SOUND, 'preview:cold').then(value => { result = value; });
  await tick();
  await f.clock.advance(resumeMs + 839);
  assert.equal(result, undefined, 'scheduled audio has not ended yet');
  assert.equal(f.contexts[0].nodes.length, 2);
  await f.clock.advance(resumeMs + 840);
  assert.deepEqual(result, { success: true });
  assert.equal(f.contexts[0].closed, 1);
  assert.ok(f.contexts[0].nodes.every(node => node.disconnected && node.target.disconnected));
});

test('a stalled resume has a bounded phase result and cannot play after its late resolution', async () => {
  const f = timedAudio({ resumeMs: 3000 });
  let result;
  f.play(FOCUS_COMPLETE_SOUND, 'preview:resume-stall').then(value => { result = value; });
  await tick(); await f.clock.advance(2500);
  assert.deepEqual(result, { success: false, code: 'audio_resume_timeout' });
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.contexts[0].nodes.length, 0);
  await f.clock.advance(5000);
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.contexts[0].nodes.length, 0);
});

test('a stalled ended event is distinguished from a stalled resume', async () => {
  const f = timedAudio({ ended: false });
  let result;
  f.play(FOCUS_COMPLETE_SOUND, 'preview:end-stall').then(value => { result = value; });
  await tick(); await f.clock.advance(2499); assert.equal(result, undefined);
  await f.clock.advance(2500);
  assert.deepEqual(result, { success: false, code: 'audio_playback_timeout' });
  assert.equal(f.contexts[0].closed, 1);
});

test('the four-second request bound retains ownership until slow playback cleanup completes', async () => {
  const f = timedAudio({ resumeMs: 2000, ended: false });
  const pending = f.play(FOCUS_COMPLETE_SOUND, 'preview:owner');
  let result; pending.then(value => { result = value; });
  await tick(); await f.clock.advance(3999);
  assert.equal(result, undefined);
  await f.clock.advance(4000);
  assert.deepEqual(result, { success: false, code: 'audio_timeout' });
  assert.equal(f.contexts[0].closed, 0, 'the playback phase still owns its context');
  assert.equal(f.play(FOCUS_COMPLETE_SOUND, 'preview:concurrent'), pending);
  assert.equal(f.contexts.length, 1);
  await f.clock.advance(4500);
  assert.equal(f.contexts[0].closed, 1);
  assert.ok(f.contexts[0].nodes.every(node => node.disconnected && node.target.disconnected));
  assert.deepEqual(await f.play(FOCUS_COMPLETE_SOUND, 'preview:owner'),
    { success: false, code: 'audio_timeout', duplicate: true });
});

test('phase results never expose arbitrary native error text or accept forged timeout codes', async () => {
  const error = Object.assign(new Error('private native detail'), { code: 'audio_resume_timeout' });
  const play = createSoundGate(() => Promise.reject(error));
  assert.deepEqual(await play(FOCUS_COMPLETE_SOUND, 'preview:denied'),
    { success: false, code: 'audio_unavailable' });
});
