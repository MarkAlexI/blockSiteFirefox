import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const localeRoot = new URL('../_locales/', import.meta.url);
const isFirefox = Boolean(manifest.browser_specific_settings?.gecko);
const expectedEnglishDescription = isFirefox
  ? 'Privacy-first website blocker for Firefox desktop and Android. 10 rules free; Pro adds schedules, daily limits and strict controls.'
  : 'Privacy-first website blocker with 10 free rules and no account. Pro adds schedules, daily limits, passwords and focus controls.';

function getLocaleDescription(locale) {
  const file = new URL(`${locale}/messages.json`, localeRoot);
  return JSON.parse(readFileSync(file, 'utf8')).description?.message;
}

test('store descriptions keep exact platform-specific English copy and matching publishing metadata', () => {
  for (const locale of ['en', 'en_CA', 'en_GB']) {
    assert.equal(getLocaleDescription(locale), expectedEnglishDescription, locale);
  }

  const metadataFile = new URL('../metadata.json', import.meta.url);
  if (existsSync(metadataFile)) {
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
    assert.equal(metadata.summary?.['en-US'], expectedEnglishDescription);
  }
});

test('all existing locales describe Free and Pro access within the store character limit', () => {
  assert.equal(manifest.description, '__MSG_description__');

  const locales = readdirSync(localeRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  assert.ok(locales.length > 0);

  for (const locale of locales) {
    const description = getLocaleDescription(locale);
    assert.equal(typeof description, 'string', locale);
    assert.ok(description.length > 0, `${locale}: missing description`);
    assert.ok([...description].length <= 132, `${locale}: description exceeds 132 characters`);
    assert.ok(description.includes('10'), `${locale}: missing ten-rule Free limit`);
    assert.ok(description.includes('Pro'), `${locale}: missing Pro features`);
    assert.doesNotMatch(description, /[\u2013\u2014]/u, `${locale}: unexpected long dash`);

    if (isFirefox) {
      assert.ok(description.includes('Firefox'), `${locale}: missing Firefox`);
      assert.ok(description.includes('Android'), `${locale}: missing Android`);
    } else {
      assert.doesNotMatch(description, /Firefox|Android/u, `${locale}: wrong platform`);
    }
  }
});
