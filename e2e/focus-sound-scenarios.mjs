import assert from 'node:assert/strict';
import { openSoundOptions, requestSoundPreview } from './sound-options.mjs';
import { installSoundObservation, readSoundObservation } from './sound-observation.mjs';

const until = async (read, check, label) => {
  const deadline = Date.now() + 15000;
  let value;
  do { value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
const click = (page, selector) => page.locator ? page.locator(selector).click() : page.click(selector);

export const focusSoundScenarios = [{
  id: '68', title: 'Focus sound uses native audio for preview and completion and releases playback resources',
  async run(e) {
    const soundView = await openSoundOptions(e);
    const options = soundView.page;
    const evidence = { scope: 'native extension audio execution; not physical speaker or Android acceptance',
      activation: soundView.activation };
    let observing = false;
    const observed = async count => until(() => options.evaluate(readSoundObservation), state =>
      state.contexts.length === count && (state.backend.startsWith('Firefox') ?
        state.contexts.every(context => context.closed && context.gains === 2 && context.ended === 2 && context.peak > 0.001) : state.offscreenOpen === 0),
    `${count} completed native sound contexts`);
    try {
      const initial = await soundView.captureActivation('before-observation');
      assert.equal(initial.sticky, false, JSON.stringify(evidence.activation));
      Object.assign(evidence, await options.evaluate(installSoundObservation));
      observing = true;
      await soundView.captureActivation('after-observation');
      const before = await options.evaluate(async () => {
        const api = globalThis.browser || chrome;
        const { settings = {} } = await api.storage.sync.get('settings');
        return { enabled: settings.focusSessionSound, focus: (await api.storage.local.get('focusSession')).focusSession,
          activated: navigator.userActivation.hasBeenActive };
      });
      const prepared = await soundView.captureActivation('after-read-only-fixture');
      assert.equal(before.enabled, false);
      assert.equal(prepared.sticky, false, JSON.stringify(evidence.activation));
      assert.equal(before.activated, false, JSON.stringify(evidence.activation));
      evidence.firstPreview = await options.evaluate(requestSoundPreview);
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
      if (observing) {
        try { evidence.final = await options.evaluate(readSoundObservation); }
        finally {
          await options.evaluate(() => { window.__bdSoundObservation.restore(); delete window.__bdSoundObservation; });
        }
      }
      if (e.result) e.result.focusSoundEvidence = evidence;
      if (e.testInfo) await e.testInfo.attach('focus-sound', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      await soundView.close();
    }
  }
}, {
  id: '69', title: 'Cold Focus preview succeeds without Web Audio observation or content activation',
  async run(e) {
    const soundView = await openSoundOptions(e);
    const evidence = { scope: 'fresh-profile production preview without prototype observation',
      activation: soundView.activation };
    try {
      const options = soundView.page;
      const initial = await soundView.captureActivation('before-preview');
      assert.equal(initial.sticky, false, JSON.stringify(evidence.activation));
      const before = await options.evaluate(async () => {
        const api = globalThis.browser || chrome;
        return { focus: (await api.storage.local.get('focusSession')).focusSession,
          enabled: (await api.storage.sync.get('settings')).settings.focusSessionSound };
      });
      assert.equal(before.enabled, false);
      const ready = await soundView.captureActivation('after-read-only-fixture');
      assert.equal(ready.sticky, false, JSON.stringify(evidence.activation));
      const started = Date.now();
      evidence.preview = await options.evaluate(requestSoundPreview);
      evidence.elapsedMs = Date.now() - started;
      assert.equal(evidence.preview.success, true, JSON.stringify(evidence.preview));
      assert.deepEqual(await options.evaluate(async () => {
        const api = globalThis.browser || chrome;
        return { focus: (await api.storage.local.get('focusSession')).focusSession,
          enabled: (await api.storage.sync.get('settings')).settings.focusSessionSound };
      }), before);
    } finally {
      if (e.result) e.result.focusSoundEvidence = evidence;
      if (e.testInfo) await e.testInfo.attach('focus-sound-unobserved', {
        body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      await soundView.close();
    }
  }
}];
