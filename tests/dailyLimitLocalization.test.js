import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesRoot = path.join(root, '_locales');
const REQUIRED_KEYS = [
  'blockingmode_header',
  'blocking_mode_always',
  'blocking_mode_schedule',
  'blocking_mode_daily_limit',
  'daily_limit_minutes_label',
  'daily_limit_hint',
  'daily_limit_usage',
  'daily_limit_reached',
  'daily_limit_invalid',
  'schedule_required',
  'blocking_mode_conflict',
  'blocking_mode_invalid'
];
const ENGLISH_LOCALES = new Set(['en', 'en_CA', 'en_GB']);

 test('all locales contain the Daily Limits message contract', async () => {
  const locales = (await readdir(localesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  assert.equal(locales.length, 57);
  const english = JSON.parse(await readFile(path.join(localesRoot, 'en', 'messages.json'), 'utf8'));

  for (const locale of locales) {
    const messages = JSON.parse(await readFile(path.join(localesRoot, locale, 'messages.json'), 'utf8'));
    for (const key of REQUIRED_KEYS) {
      assert.equal(typeof messages[key]?.message, 'string', `${locale}: missing ${key}`);
      assert.notEqual(messages[key].message.trim(), '', `${locale}: empty ${key}`);
    }
    assert.equal(messages.daily_limit_usage.placeholders?.used?.content, '$1', `${locale}: USED placeholder`);
    assert.equal(messages.daily_limit_usage.placeholders?.limit?.content, '$2', `${locale}: LIMIT placeholder`);
    if (!ENGLISH_LOCALES.has(locale)) {
      assert.notEqual(messages.blocking_mode_daily_limit.message, english.blocking_mode_daily_limit.message, `${locale}: Daily limit is untranslated`);
    }
  }
});
