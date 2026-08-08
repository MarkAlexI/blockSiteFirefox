import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredKeys = [
  'privacysettingstitle',
  'telemetryconsenttitle',
  'telemetryconsentdesc',
  'telemetryprivacynotice',
  'telemetryenabled',
  'telemetrydisabled',
  'telemetryerror'
];
const englishLocales = new Set(['en', 'en_CA', 'en_GB']);

test('all locales contain translated telemetry consent strings', async () => {
  const localeRoot = path.join(root, '_locales');
  const locales = await readdir(localeRoot);
  const english = JSON.parse(await readFile(path.join(localeRoot, 'en', 'messages.json'), 'utf8'));
  assert.equal(locales.length, 57);

  for (const locale of locales) {
    const messages = JSON.parse(await readFile(path.join(localeRoot, locale, 'messages.json'), 'utf8'));
    for (const key of requiredKeys) {
      assert.equal(typeof messages[key]?.message, 'string', `${locale}: missing ${key}`);
      assert.notEqual(messages[key].message.trim(), '', `${locale}: empty ${key}`);
      if (!englishLocales.has(locale)) {
        assert.notEqual(
          messages[key].message,
          english[key].message,
          `${locale}: ${key} still uses the English fallback`
        );
      }
    }
  }
});
