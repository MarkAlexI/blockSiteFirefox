// Test-only observation of native APIs. Return the original nodes and promises;
// do not replace playback, browser clocks, ended events or runtime responses.
export async function installSoundObservation() {
  const api = globalThis.browser || globalThis.chrome;
  const state = { backend: '', contexts: [], samples: [], errors: [], restore: null };
  window.__bdSoundObservation = state;
  if (api.runtime.getManifest().background.scripts) {
    state.backend = 'Firefox native Web Audio graph';
    const view = await api.runtime.getBackgroundPage();
    const prototype = view.AudioContext.prototype;
    const originals = Object.fromEntries(['resume', 'createGain', 'createOscillator', 'close']
      .map(name => [name, prototype[name]]));
    const records = new Map(), removeListeners = [];
    const mark = (context, stage) => {
      let record = records.get(context);
      if (!record) {
        record = { gains: 0, ended: 0, peak: 0, closed: false, startedAt: Date.now(), timeline: [] };
        records.set(context, record); state.contexts.push(record);
        const changed = () => {
          record.timeline.push({ stage: 'statechange', at: view.performance.now(), state: context.state });
          if (context.state === 'closed') { record.closed = true; view.clearInterval(record.timer); }
        };
        context.addEventListener('statechange', changed);
        removeListeners.push(() => context.removeEventListener('statechange', changed));
      }
      record.timeline.push({ stage, at: view.performance.now(), state: context.state, audioTime: context.currentTime });
      return record;
    };
    const failure = (context, stage, error) => {
      mark(context, stage);
      state.errors.push({ stage, name: error?.name || 'Error', message: error?.message || String(error) });
    };
    for (const name of ['resume', 'close']) {
      prototype[name] = function (...args) {
        mark(this, name + ':begin');
        try {
          const promise = originals[name].apply(this, args);
          // Observe settlement without returning a replacement Promise.
          void promise.then(() => mark(this, name + ':resolved'),
            error => failure(this, name + ':rejected', error));
          return promise;
        } catch (error) { failure(this, name + ':threw', error); throw error; }
      };
    }
    prototype.createOscillator = function (...args) {
      try {
        const node = originals.createOscillator.apply(this, args);
        mark(this, 'oscillator:create');
        const ended = () => { mark(this, 'oscillator:ended').ended++; };
        node.addEventListener('ended', ended);
        removeListeners.push(() => node.removeEventListener('ended', ended));
        return node;
      } catch (error) { failure(this, 'createOscillator', error); throw error; }
    };
    prototype.createGain = function (...args) {
      try {
        const gain = originals.createGain.apply(this, args);
        const record = mark(this, 'gain:create'); record.gains++;
        const analyser = this.createAnalyser(); gain.connect(analyser);
        const values = new view.Float32Array(analyser.fftSize);
        // The first analyser samples one real note. Production still connects
        // both original gains to its native destination.
        if (!record.timer) record.timer = view.setInterval(() => {
          analyser.getFloatTimeDomainData(values);
          for (const value of values) record.peak = Math.max(record.peak, Math.abs(value));
        }, 10);
        return gain;
      } catch (error) { failure(this, 'createGain', error); throw error; }
    };
    state.restore = () => {
      Object.assign(prototype, originals);
      for (const record of records.values()) view.clearInterval(record.timer);
      for (const remove of removeListeners) remove();
    };
  } else {
    state.backend = 'Chromium native offscreen contexts';
    let reading = false;
    const seen = new Set();
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [api.runtime.getURL('scripts/sound-offscreen.html')] });
        for (const context of contexts) if (!seen.has(context.contextId)) {
          seen.add(context.contextId); state.contexts.push({ contextId: context.contextId, documentUrl: context.documentUrl });
        }
        state.samples.push({ at: Date.now(), open: contexts.length });
      } catch (error) { state.errors.push(String(error)); }
      finally { reading = false; }
    }, 25);
    state.restore = () => clearInterval(timer);
  }
  return { backend: state.backend };
}

export async function readSoundObservation() {
  const state = window.__bdSoundObservation;
  return { backend: state.backend, errors: state.errors,
    contexts: state.contexts.map(({ timer: _timer, ...record }) => record),
    offscreenOpen: state.samples.at(-1)?.open ?? null };
}
