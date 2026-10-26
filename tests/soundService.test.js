import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoundService } from '../utils/soundService.js';
import { audioFixture } from './helpers/soundFixture.js';

test('Firefox event-page service uses native DOM audio without offscreen, tabs or permanent contexts', async () => {
  const f = audioFixture(); const service = createSoundService({ AudioContextCtor: f.AudioContext });
  assert.equal(f.contexts.length, 0);
  assert.equal((await service.play('focus-complete', 'focus:1')).success, true);
  assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].closed, 1);
  assert.equal((await service.play('focus-complete', 'focus:1')).duplicate, true);
  assert.equal(f.contexts.length, 1);
  await service.play('focus-complete', 'preview:1');
  assert.equal(f.contexts.length, 2); assert.equal(f.contexts[1].closed, 1);
});
test('Firefox autoplay rejection is a failed sound result and a later explicit preview can recover', async () => {
  let blocked = true;
  const f = audioFixture({ resume: async () => { if (blocked) throw new Error('NotAllowedError'); } });
  const service = createSoundService({ AudioContextCtor: f.AudioContext });
  assert.equal((await service.play('focus-complete', 'focus:1')).success, false);
  assert.equal(f.contexts[0].closed, 1);
  blocked = false;
  assert.equal((await service.play('focus-complete', 'preview:1')).success, true);
  assert.equal(f.contexts[1].closed, 1);
});
test('a cancelled Firefox request never allocates Web Audio', async () => {
  const f = audioFixture(); const service = createSoundService({ AudioContextCtor: f.AudioContext });
  assert.equal((await service.play('focus-complete', 'focus:1', () => false)).success, false);
  assert.equal(f.contexts.length, 0);
});
