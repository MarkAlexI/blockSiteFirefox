import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFocusSoundController, isRecentFocusCompletion, isSoundPreviewSender } from '../utils/focusSound.js';

const now = 100_000;
test('freshness accepts the existing one-second alarm tolerance and excludes stale or invalid deadlines', () => {
  for (const end of [now + 1000, now, now - 60_000]) assert.equal(isRecentFocusCompletion(end, now), true);
  for (const end of [now + 1001, now - 60_001, 0, -1, null, undefined, NaN, Infinity, '100000']) assert.equal(isRecentFocusCompletion(end, now), false);
});

test('completion uses the persisted preference while explicit preview changes no settings', async () => {
  const calls = []; let enabled = false, reads = 0;
  const controller = createFocusSoundController({ now: () => now,
    getSettings: async options => { reads++; assert.equal(options.throwOnError, true); return { focusSessionSound: enabled }; },
    service: { async play(sound, id, allowed = () => true) { if (await allowed()) calls.push({ sound, id }); return { success: true }; } } });
  await controller.complete(now); assert.equal(calls.length, 0);
  await controller.preview(); assert.equal(calls.length, 1); assert.equal(enabled, false);
  enabled = true; await controller.complete(now);
  assert.deepEqual(calls.at(-1), { sound: 'focus-complete', id: `focus:${now}` });
  assert.equal(reads, 3);
  await controller.complete(now - 60_001); assert.equal(reads, 3); assert.equal(calls.length, 2);
});

test('settings read failure never assumes sound is enabled', async () => {
  let calls = 0;
  const controller = createFocusSoundController({ now: () => now,
    getSettings: async () => { throw new Error('storage denied'); }, service: { play() { calls++; } } });
  await assert.rejects(controller.complete(now), /storage denied/); assert.equal(calls, 0);
});

test('disabling sound while preparing the player is respected at dispatch', async () => {
  let enabled = true, played = 0;
  const controller = createFocusSoundController({ now: () => now,
    getSettings: async () => ({ focusSessionSound: enabled }),
    service: { async play(_sound, _id, allowed) { enabled = false; if (await allowed()) played++; return { success: true }; } } });
  await controller.complete(now); assert.equal(played, 0);
});

test('a completion that becomes stale while loading settings stays silent', async () => {
  let at = now, played = 0;
  const controller = createFocusSoundController({ now: () => at,
    getSettings: async () => { at += 61_000; return { focusSessionSound: true }; }, service: { play() { played++; } } });
  await controller.complete(now); assert.equal(played, 0);
});

test('only this extension Options document can request a preview', () => {
  const runtime = { id: 'own', getURL: p => `moz-extension://own/${p}` };
  for (const suffix of ['', '?x=1', '#basic-settings']) assert.equal(isSoundPreviewSender({ id: 'own', url: runtime.getURL('options/options.html') + suffix }, runtime), true);
  for (const sender of [null, {}, { id: 'other', url: runtime.getURL('options/options.html') },
    { id: 'own', url: 'https://example.test/options/options.html' },
    { id: 'own', url: runtime.getURL('options/options.html.evil') }, { id: 'own', url: runtime.getURL('index.html') }]) {
    assert.equal(isSoundPreviewSender(sender, runtime), false);
  }
});

test('all 57 locales provide the four nonempty sound labels and status messages', () => {
  const root = new URL('../_locales/', import.meta.url);
  const locales = readdirSync(root); assert.equal(locales.length, 57);
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(new URL(`${locale}/messages.json`, root), 'utf8'));
    for (const key of ['previewsound', 'soundpreviewcomplete', 'soundpreviewfailed', 'soundvolumenotice']) {
      assert.ok(messages[key]?.message?.trim(), `${locale}: ${key}`);
    }
  }
});
