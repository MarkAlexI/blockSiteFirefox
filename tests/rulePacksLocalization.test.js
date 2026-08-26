import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const RULE_PACK_KEY_PATTERN = /^rulepacks?_/;
const ENGLISH_LOCALES = new Set(['en', 'en_CA', 'en_GB']);
const ALLOWED_ENGLISH_MATCHES = new Map([
  ['fil', new Set(['rulepack_social_title'])]
]);

function getPlaceholders(message) {
  return [...message.matchAll(/\$([A-Za-z0-9_]+)\$/g)]
    .map(match => match[1])
    .sort();
}

async function readMessages(locale) {
  return JSON.parse(
    await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8')
  );
}

test('all locales provide complete localized Rule Packs messages', async () => {
  const englishMessages = await readMessages('en');
  const rulePackKeys = Object.keys(englishMessages)
    .filter(key => RULE_PACK_KEY_PATTERN.test(key))
    .sort();
  const locales = (await readdir(new URL('../_locales/', import.meta.url), {
    withFileTypes: true
  }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  assert.equal(rulePackKeys.length, 31);
  assert.equal(locales.length, 57);

  for (const locale of locales) {
    const messages = await readMessages(locale);

    for (const key of rulePackKeys) {
      assert.ok(messages[key], `${locale}: missing ${key}`);
      assert.equal(
        typeof messages[key].message,
        'string',
        `${locale}: ${key} must contain a string message`
      );
      assert.ok(
        messages[key].message.trim().length > 0,
        `${locale}: ${key} must not be empty`
      );
      assert.deepEqual(
        getPlaceholders(messages[key].message),
        getPlaceholders(englishMessages[key].message),
        `${locale}: ${key} placeholder mismatch`
      );

      if (!ENGLISH_LOCALES.has(locale)) {
        const englishMatchAllowed = ALLOWED_ENGLISH_MATCHES.get(locale)?.has(key);
        if (!englishMatchAllowed) {
          assert.notEqual(
            messages[key].message,
            englishMessages[key].message,
            `${locale}: ${key} still uses the English fallback`
          );
        }
      }
    }
  }
});
