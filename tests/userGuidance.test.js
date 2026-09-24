import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import {
  STARTER_TIP_KEYS_BY_DAY,
  getStarterTipKeys
} from '../options/userGuidance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const installedAt = Date.parse('2026-09-23T12:00:00.000Z');

test('starter tips show two stable messages on each of the first two days', () => {
  assert.deepEqual(
    getStarterTipKeys(new Date(installedAt).toISOString(), installedAt),
    [...STARTER_TIP_KEYS_BY_DAY[0]]
  );
  assert.deepEqual(
    getStarterTipKeys(new Date(installedAt).toISOString(), installedAt + DAY_MS),
    [...STARTER_TIP_KEYS_BY_DAY[1]]
  );
});

test('starter tips stay hidden outside the first 48 hours or without a valid date', () => {
  assert.deepEqual(getStarterTipKeys('not-a-date', installedAt), []);
  assert.deepEqual(getStarterTipKeys(new Date(installedAt).toISOString(), installedAt - 1), []);
  assert.deepEqual(getStarterTipKeys(new Date(installedAt).toISOString(), installedAt + 2 * DAY_MS), []);
});

test('guide and quick actions use the public guide without new extension permissions', async () => {
  const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
  const popup = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

  assert.match(html, /id="quick-add-rule"/);
  assert.match(html, /https:\/\/blockdistraction\.com\/user-guide\.html/);
  assert.match(popup, /https:\/\/blockdistraction\.com\/user-guide\.html/);
  assert.equal(manifest.permissions.includes('history'), false);
});

test('all 57 locales provide a translated User Guide label', async () => {
  const localesRoot = new URL('../_locales/', import.meta.url);
  const localeNames = (await readdir(localesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const englishLocales = new Set(['en', 'en_CA', 'en_GB']);
  const english = JSON.parse(await readFile(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));

  assert.equal(localeNames.length, 57);
  for (const locale of localeNames) {
    const messages = JSON.parse(await readFile(new URL('../_locales/' + locale + '/messages.json', import.meta.url), 'utf8'));
    assert.equal(typeof messages.userguide?.message, 'string', locale + ': missing userguide');
    assert.notEqual(messages.userguide.message.trim(), '', locale + ': empty userguide');
    if (!englishLocales.has(locale)) {
      assert.notEqual(messages.userguide.message, english.userguide.message, locale + ': untranslated userguide');
    }
  }
});
