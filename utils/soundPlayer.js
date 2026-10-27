export const FOCUS_COMPLETE_SOUND = 'focus-complete';
export const SOUND_TIMEOUT_MS = 4000;

class AudioPhaseTimeoutError extends Error {
  constructor(phase) {
    super(`Audio ${phase} timed out`);
    this.code = `audio_${phase}_timeout`;
  }
}

async function waitForAudioPhase(operation, phase, setTimer, clearTimer) {
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimer(() => reject(new AudioPhaseTimeoutError(phase)), 2500);
    });
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimer(timer);
  }
}

export function isSupportedSound(sound) {
  return sound === FOCUS_COMPLETE_SOUND;
}

// One owner covers preparation, playback and cleanup. A timed-out caller does
// not release that owner: a late createDocument must finish cleanup before a
// later request can create another document or play a delayed sound.
export function createSoundGate(operation, {
  timeoutMs = SOUND_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let active = null;
  const recent = new Map();
  return function play(sound, requestId, canPlay = () => true) {
    if (!isSupportedSound(sound) || typeof requestId !== 'string' || !requestId || requestId.length > 160) {
      return Promise.resolve({ success: false, code: 'invalid_sound' });
    }
    if (active) return active.reply;
    if (recent.has(requestId)) return Promise.resolve({ ...recent.get(requestId), duplicate: true });
    recent.set(requestId, { success: false, code: 'audio_pending' });
    if (recent.size > 32) recent.delete(recent.keys().next().value);
    const owner = {};
    active = owner;
    let expired = false;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimer(() => {
        expired = true;
        const result = { success: false, code: 'audio_timeout' };
        recent.set(requestId, result);
        resolve(result);
      }, timeoutMs);
    });
    const work = Promise.resolve().then(() => operation(sound, requestId,
      async () => !expired && await canPlay() && !expired))
      .then(result => result || { success: false, code: 'audio_unavailable' },
        error => ({ success: false,
          code: error instanceof AudioPhaseTimeoutError ? error.code : 'audio_unavailable' }))
      .then(result => {
        if (!expired) recent.set(requestId, result);
        return result;
      })
      .finally(() => {
        clearTimer(timer);
        if (active === owner) active = null;
      });
    owner.reply = Promise.race([work, timeout]);
    return owner.reply;
  };
}

// A finite two-note chime. No audio context, oscillator or silent keepalive is
// retained between requests. The envelope avoids clicks at either boundary.
export async function playFocusChime({
  AudioContextCtor = globalThis.AudioContext,
  canPlay = () => true,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof AudioContextCtor !== 'function' || !await canPlay()) {
    return { success: false, code: 'audio_unavailable' };
  }
  const context = new AudioContextCtor({ latencyHint: 'interactive' });
  const nodes = [];
  try {
    // A cold audio backend must not spend the chime's playback budget.
    // The request owner still bounds the caller's entire attempt to 4 seconds.
    await waitForAudioPhase(() => context.resume(), 'resume', setTimer, clearTimer);
    if (context.state !== 'running' || !await canPlay()) return { success: false, code: 'audio_unavailable' };
    const start = context.currentTime + 0.025;
    const ended = new Promise(resolve => {
      for (const [index, [frequency, offset, duration]] of [[659.25, 0, 0.32], [880, 0.22, 0.58]].entries()) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        nodes.push({ oscillator, gain });
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, start + offset);
        gain.gain.setValueAtTime(0, start + offset);
        // Hold a useful level before fading: an immediate exponential decay
        // made the original chime much quieter than ordinary notifications.
        gain.gain.linearRampToValueAtTime(0.6, start + offset + 0.015);
        gain.gain.setValueAtTime(0.6, start + offset + duration * 0.4);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
        gain.gain.linearRampToValueAtTime(0, start + offset + duration + 0.015);
        oscillator.connect(gain);
        gain.connect(context.destination);
        if (index === 1) oscillator.onended = resolve;
        oscillator.start(start + offset);
        oscillator.stop(start + offset + duration + 0.015);
      }
    });
    await waitForAudioPhase(() => ended, 'playback', setTimer, clearTimer);
    return { success: true };
  } finally {
    for (const { oscillator, gain } of nodes) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Already stopped. */ }
      oscillator.disconnect();
      gain.disconnect();
    }
    // Do not let a platform close acknowledgement stall Focus transitions.
    try { context.close()?.catch?.(() => {}); } catch { /* Already closed. */ }
  }
}
