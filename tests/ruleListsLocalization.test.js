import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesRoot = path.join(root, '_locales');
const REQUIRED_KEYS = [
  'rulelists_title',
  'rulelists_description',
  'rulelists_name_placeholder',
  'rulelists_add',
  'rulelist_general',
  'rulelist_header',
  'rulelists_name_invalid',
  'rulelists_name_exists',
  'rulelists_delete_confirm',
  'rulelists_remove_assignment',
  'rulelists_assignment_exists',
  'rulelists_assignment_error'
];

const OBSOLETE_PROFILE_KEYS = [
  'rulelists_toggle_hint',
  'rulelists_all',
  'rulelists_disabled_desc',
  'rulelists_muted_no_edit',
  'rulelists_assignment_hint',
  'rulelists_remove_assignment_confirm',
  'rulelists_multiple_settings'
];

test('all locales contain the active-profile Rule Lists message contract', async () => {
  const localeNames = (await readdir(localesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  assert.ok(localeNames.length >= 50);

  for (const locale of localeNames) {
    const messages = JSON.parse(
      await readFile(path.join(localesRoot, locale, 'messages.json'), 'utf8')
    );

    for (const key of REQUIRED_KEYS) {
      assert.equal(typeof messages[key]?.message, 'string', `${locale}: missing ${key}`);
      assert.notEqual(messages[key].message.trim(), '', `${locale}: empty ${key}`);
    }

    assert.equal(
      messages.rulelists_delete_confirm.message.includes('$NAME$'),
      true,
      `${locale}: delete confirmation must keep $NAME$`
    );
    assert.equal(
      messages.rulelists_delete_confirm.placeholders?.name?.content,
      '$1',
      `${locale}: delete confirmation must define NAME placeholder`
    );

    for (const key of OBSOLETE_PROFILE_KEYS) {
      assert.equal(messages[key], undefined, `${locale}: obsolete ${key} should be removed`);
    }
  }
});

test('profile Rule List copy is localized outside English locales', async () => {
  const keys = [
    'rulelists_description',
    'rulelists_remove_assignment',
    'rulelists_assignment_exists',
    'rulelists_assignment_error'
  ];
  const english = JSON.parse(
    await readFile(path.join(localesRoot, 'en', 'messages.json'), 'utf8')
  );
  const localeNames = (await readdir(localesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(locale => !['en', 'en_CA', 'en_GB'].includes(locale));

  for (const locale of localeNames) {
    const messages = JSON.parse(
      await readFile(path.join(localesRoot, locale, 'messages.json'), 'utf8')
    );
    for (const key of keys) {
      assert.notEqual(
        messages[key].message,
        english[key].message,
        `${locale}: ${key} still uses the English fallback`
      );
    }
  }
});
