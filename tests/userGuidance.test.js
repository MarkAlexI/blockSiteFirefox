import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import {
  PRO_GUIDANCE_STORAGE_KEY,
  PRO_GUIDANCE_VERSION,
  PRO_TIP_KEYS,
  STARTER_TIP_KEYS_BY_DAY,
  dismissProGuidance,
  getStarterTipKeys,
  getStarterTipText,
  resolveProGuidance
} from '../options/userGuidance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const installedAt = Date.parse('2026-09-23T12:00:00.000Z');

test('starter tips show two stable messages on each of the first three days', () => {
  assert.deepEqual(
    getStarterTipKeys(new Date(installedAt).toISOString(), installedAt),
    [...STARTER_TIP_KEYS_BY_DAY[0]]
  );
  assert.deepEqual(
    getStarterTipKeys(new Date(installedAt).toISOString(), installedAt + DAY_MS),
    [...STARTER_TIP_KEYS_BY_DAY[1]]
  );
  assert.deepEqual(
    getStarterTipKeys(new Date(installedAt).toISOString(), installedAt + 2 * DAY_MS),
    [...STARTER_TIP_KEYS_BY_DAY[2]]
  );
});

test('starter tips stay hidden outside the first 72 hours or without a valid date', () => {
  assert.deepEqual(getStarterTipKeys('not-a-date', installedAt), []);
  assert.deepEqual(getStarterTipKeys(new Date(installedAt).toISOString(), installedAt - 1), []);
  assert.deepEqual(getStarterTipKeys(new Date(installedAt).toISOString(), installedAt + 3 * DAY_MS), []);
});

test('feature starter tips identify the controls they describe', () => {
  const messages = {
    redirecturlheader: 'Redirect URL',
    redirecturlhint: 'Enter a full URL including https://',
    mobilecopylinkhint: 'Copy the address.',
    strictmodetitle: 'Strict Mode',
    strictmodedesc: 'Rules require a countdown.',
    focussessionheader: 'Focus Session',
    focussessioninfo: 'Activates all blocking rules for a set time.'
  };
  const translate = key => messages[key];

  assert.equal(
    getStarterTipText('redirecturlhint', translate),
    'Redirect URL: Enter a full URL including https://'
  );
  assert.equal(getStarterTipText('mobilecopylinkhint', translate), 'Copy the address.');
  assert.equal(
    getStarterTipText('strictmodedesc', translate),
    'Strict Mode: Rules require a countdown.'
  );
  assert.equal(
    getStarterTipText('focussessioninfo', translate),
    'Focus Session: Activates all blocking rules for a set time.'
  );
});

test('Pro guidance starts locally with the first tip and stays stable on the same day', () => {
  const first = resolveProGuidance(undefined, new Date(2026, 8, 27, 8).getTime());
  assert.equal(PRO_GUIDANCE_STORAGE_KEY, 'proGuidance');
  assert.equal(first.tipKey, PRO_TIP_KEYS[0]);
  assert.equal(first.changed, true);
  assert.equal(first.state.version, PRO_GUIDANCE_VERSION);

  const sameDay = resolveProGuidance(first.state, new Date(2026, 8, 27, 20).getTime());
  assert.equal(sameDay.tipKey, PRO_TIP_KEYS[0]);
  assert.equal(sameDay.changed, false);
});

test('Pro guidance advances one tip per returning day without skipping missed days', () => {
  const first = resolveProGuidance(undefined, Date.parse('2026-09-01T08:00:00Z'));
  const afterLongGap = resolveProGuidance(first.state, Date.parse('2026-09-20T08:00:00Z'));
  assert.equal(afterLongGap.tipKey, PRO_TIP_KEYS[1]);
  assert.equal(afterLongGap.state.tipIndex, 1);

  const nextDay = resolveProGuidance(afterLongGap.state, Date.parse('2026-09-21T08:00:00Z'));
  assert.equal(nextDay.tipKey, PRO_TIP_KEYS[2]);
});

test('Pro guidance can be dismissed and completes after the final tip', () => {
  const first = resolveProGuidance(undefined, Date.parse('2026-09-01T08:00:00Z'));
  const dismissed = dismissProGuidance(first.state, Date.parse('2026-09-01T09:00:00Z'));
  assert.equal(resolveProGuidance(dismissed, Date.parse('2026-09-02T08:00:00Z')).tipKey, null);

  let state = first.state;
  for (let index = 1; index < PRO_TIP_KEYS.length; index += 1) {
    state = resolveProGuidance(
      state,
      Date.parse('2026-09-' + String(index + 1).padStart(2, '0') + 'T08:00:00Z')
    ).state;
  }
  const completed = resolveProGuidance(state, Date.parse('2026-09-09T08:00:00Z'));
  assert.equal(completed.tipKey, null);
  assert.equal(completed.state.completed, true);
});

test('invalid Pro guidance state restarts safely while future dates do not advance', () => {
  const restarted = resolveProGuidance({ version: 1, tipIndex: -1 }, Date.parse('2026-09-27T08:00:00Z'));
  assert.equal(restarted.tipKey, PRO_TIP_KEYS[0]);
  assert.equal(restarted.changed, true);

  const futureState = {
    version: PRO_GUIDANCE_VERSION,
    tipIndex: 2,
    lastShownDay: '2026-09-30',
    dismissed: false,
    completed: false
  };
  const unchanged = resolveProGuidance(futureState, Date.parse('2026-09-27T08:00:00Z'));
  assert.equal(unchanged.tipKey, PRO_TIP_KEYS[2]);
  assert.equal(unchanged.changed, false);
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

test('all 57 locales provide User Guide and complete starter and Pro guidance', async () => {
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
    assert.notEqual(messages.redirecturlheader?.message?.trim(), '', locale + ': missing redirect URL header');
    assert.notEqual(messages.redirecturlhint?.message?.trim(), '', locale + ': missing redirect URL hint');
    assert.match(messages.startertip_path_rule?.message || '', /example\.com\/videos/, locale + ': missing path tip');
    assert.notEqual(messages.startertip_pause_rule?.message?.trim(), '', locale + ': missing pause tip');
    assert.notEqual(messages.protips_title?.message?.trim(), '', locale + ': missing Pro tips title');
    assert.notEqual(messages.protips_dismiss?.message?.trim(), '', locale + ': missing Pro tips dismiss action');
    for (const key of PRO_TIP_KEYS) {
      assert.notEqual(messages[key]?.message?.trim(), '', locale + ': missing ' + key);
    }
    for (const [key, label] of [
      ['redirecturlhint', 'redirect'],
      ['strictmodedesc', 'Strict Mode'],
      ['focussessioninfo', 'Focus Session']
    ]) {
      assert.match(
        getStarterTipText(key, messageKey => messages[messageKey]?.message || ''),
        /:\s\S/,
        locale + ': ' + label + ' starter tip is not qualified'
      );
    }
    if (!englishLocales.has(locale)) {
      assert.notEqual(messages.userguide.message, english.userguide.message, locale + ': untranslated userguide');
      assert.notEqual(
        messages.startertip_path_rule.message,
        english.startertip_path_rule.message,
        locale + ': untranslated path tip'
      );
      assert.notEqual(
        messages.startertip_pause_rule.message,
        english.startertip_pause_rule.message,
        locale + ': untranslated pause tip'
      );
      for (const key of ['protips_title', 'protips_dismiss', ...PRO_TIP_KEYS]) {
        assert.notEqual(messages[key].message, english[key].message, locale + ': untranslated ' + key);
      }
    }
  }
});
