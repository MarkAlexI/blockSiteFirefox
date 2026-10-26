import { createSoundGate, playFocusChime } from './soundPlayer.js';

// Firefox's non-persistent event page already has DOM and Web Audio. It does
// not need a tab, offscreen permission or a permanent AudioContext.
export function createSoundService({ AudioContextCtor, ...gateOptions } = {}) {
  const play = createSoundGate((_sound, _requestId, isCurrent) =>
    playFocusChime({ AudioContextCtor: AudioContextCtor ?? globalThis.AudioContext, canPlay: isCurrent }), gateOptions);
  return { play };
}
