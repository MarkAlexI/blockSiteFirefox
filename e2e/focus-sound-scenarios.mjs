import assert from 'node:assert/strict';

const until = async (read, check, label) => {
  const deadline = Date.now() + 15000;
  let value;
  do { value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
const click = (page, selector) => page.locator ? page.locator(selector).click() : page.click(selector);

// Observe real browser Web Audio without replacing playback, clocks, responses
// or native ended events. A parallel analyser measures generated signal energy;
// it cannot establish physical speaker audibility or Android device behavior.
async function installSoundObservation() {
  const api = globalThis.browser || globalThis.chrome;
  const state = { backend: '', contexts: [], samples: [], errors: [], restore: null };
  window.__bdSoundObservation = state;
  if (api.runtime.getManifest().background.scripts) {
    state.backend = 'Firefox native Web Audio graph';
    const view = await api.runtime.getBackgroundPage();
    const prototype = view.AudioContext.prototype;
    const original = prototype.createGain;
    const records = new Map();
    prototype.createGain = function (...args) {
      const gain = original.apply(this, args);
      let record = records.get(this);
      if (!record) {
        record = { gains: 0, peak: 0, closed: false, startedAt: Date.now() };
        records.set(this, record); state.contexts.push(record);
        const context = this;
        context.addEventListener('statechange', () => {
          if (context.state === 'closed') { record.closed = true; view.clearInterval(record.timer); }
        });
      }
      record.gains++;
      const analyser = this.createAnalyser(); gain.connect(analyser);
      const values = new Float32Array(analyser.fftSize);
      // The first analyser sees one actual note; the second gain still goes
      // through production's native destination connection unchanged.
      if (!record.timer) record.timer = view.setInterval(() => {
        analyser.getFloatTimeDomainData(values);
        for (const value of values) record.peak = Math.max(record.peak, Math.abs(value));
      }, 10);
      return gain;
    };
    state.restore = () => { prototype.createGain = original; for (const r of records.values()) view.clearInterval(r.timer); };
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

async function readSoundObservation() {
  const s = window.__bdSoundObservation;
  return { backend: s.backend, errors: s.errors,
    contexts: s.contexts.map(({ timer: _timer, ...record }) => record),
    offscreenOpen: s.samples.at(-1)?.open ?? null };
}

export const focusSoundScenarios = [{
  id: '68', title: 'Focus sound uses native audio for preview and completion and releases playback resources',
  async run(e) {
    const options = await e.openOptions();
    const observation = await options.evaluate(installSoundObservation);
    const evidence = { scope: 'native extension audio execution; not physical speaker or Android acceptance', ...observation };
    const observed = async count => until(() => options.evaluate(readSoundObservation), state =>
      state.contexts.length === count && (state.backend.startsWith('Firefox') ?
        state.contexts.every(context => context.closed && context.gains === 2 && context.peak > 0.001) : state.offscreenOpen === 0),
    `${count} completed native sound contexts`);
    try {
      const before = await options.evaluate(async () => {
        const api = globalThis.browser || chrome;
        const { settings = {} } = await api.storage.sync.get('settings');
        await api.storage.sync.set({ settings: { ...settings, focusSessionSound: false } });
        return { focus: (await api.storage.local.get('focusSession')).focusSession,
          activated: navigator.userActivation.hasBeenActive };
      });
      assert.equal(before.activated, false, 'first preview has no prior content user activation');
      evidence.firstPreview = await options.evaluate(() => (globalThis.browser || chrome).runtime.sendMessage({ type: 'sound:preview' }));
      assert.equal(evidence.firstPreview.success, true, JSON.stringify(evidence.firstPreview));
      await observed(1);

      const expanded = await options.evaluate(() => document.querySelector('[aria-controls="basic-settings-panel"]').getAttribute('aria-expanded'));
      if (expanded !== 'true') await click(options, '[aria-controls="basic-settings-panel"]');
      await options.evaluate(() => {
        window.__bdListenTrusted = null;
        document.getElementById('previewFocusSound').addEventListener('click', event => { window.__bdListenTrusted = event.isTrusted; }, { once: true });
      });
      await click(options, '#previewFocusSound');
      evidence.listen = await until(() => options.evaluate(() => ({
        trusted: window.__bdListenTrusted, busy: document.getElementById('previewFocusSound').getAttribute('aria-busy'),
        text: document.getElementById('focusSoundStatus').textContent,
        expected: (globalThis.browser || chrome).i18n.getMessage('soundpreviewcomplete')
      })), v => v.trusted === true && v.busy === 'false' && v.text === v.expected, 'one real Listen click completed');
      await observed(2);
      assert.deepEqual(await options.evaluate(async () => {
        const api = globalThis.browser || chrome;
        return { focus: (await api.storage.local.get('focusSession')).focusSession,
          enabled: (await api.storage.sync.get('settings')).settings.focusSessionSound };
      }), { focus: before.focus, enabled: false });

      // Controlled deadline fixture followed by a real native alarm. No fake
      // Date, onAlarm dispatch, AudioContext or media completion is used.
      await options.evaluate(async () => {
        const api = globalThis.browser || chrome;
        const { settings } = await api.storage.sync.get('settings');
        await api.storage.sync.set({ settings: { ...settings, focusSessionSound: true } });
        const end = Date.now() + 1500;
        await api.storage.local.set({ focusSession: { focusActive: true, focusEndTime: end,
          isHardcore: false, focusMode: 'blacklist' } });
        await api.alarms.create('end_focus_session', { when: end });
      });
      await until(() => options.evaluate(async () =>
        (await (globalThis.browser || chrome).storage.local.get('focusSession')).focusSession.focusActive),
      active => active === false, 'native Focus completion committed');
      evidence.completed = await observed(3);
      assert.deepEqual(evidence.completed.errors, []);
    } finally {
      evidence.final = await options.evaluate(readSoundObservation);
      await options.evaluate(() => { window.__bdSoundObservation.restore(); delete window.__bdSoundObservation; });
      if (e.result) e.result.focusSoundEvidence = evidence;
      if (e.testInfo) await e.testInfo.attach('focus-sound', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    }
  }
}];
