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
  'rulelists_toggle_hint',
  'rulelist_general',
  'rulelists_all',
  'rulelist_header',
  'rulelists_disabled_desc',
  'rulelists_muted_no_edit',
  'rulelists_name_invalid',
  'rulelists_name_exists',
  'rulelists_delete_confirm',
  'rulelists_assignment_hint',
  'rulelists_remove_assignment',
  'rulelists_remove_assignment_confirm',
  'rulelists_assignment_exists',
  'rulelists_assignment_error',
  'rulelists_multiple_settings'
];

test('all locales contain the Rule Lists message contract', async () => {
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
    assert.equal(
      messages.rulelists_remove_assignment_confirm.message.includes('$NAME$'),
      true,
      `${locale}: assignment removal confirmation must keep $NAME$`
    );
    assert.equal(
      messages.rulelists_remove_assignment_confirm.placeholders?.name?.content,
      '$1',
      `${locale}: assignment removal confirmation must define NAME placeholder`
    );
  }
});

test('assignment-specific Rule List strings are localized outside English locales', async () => {
  const assignmentKeys = [
    'rulelists_assignment_hint',
    'rulelists_remove_assignment',
    'rulelists_remove_assignment_confirm',
    'rulelists_assignment_exists',
    'rulelists_assignment_error',
    'rulelists_multiple_settings'
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
    for (const key of assignmentKeys) {
      assert.notEqual(
        messages[key].message,
        english[key].message,
        `${locale}: ${key} still uses the English fallback`
      );
    }
  }
});
