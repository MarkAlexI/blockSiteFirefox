import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const localesRoot = join(projectRoot, '_locales');

async function readMessages(locale) {
  return JSON.parse(await readFile(join(localesRoot, locale, 'messages.json'), 'utf8'));
}

test('all 57 locales include every default English message key', async () => {
  const entries = await readdir(localesRoot, { withFileTypes: true });
  const locales = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  assert.equal(locales.length, 57);

  const defaultMessages = await readMessages('en');
  const requiredKeys = Object.keys(defaultMessages).sort();
  const missing = [];
  const empty = [];

  for (const locale of locales) {
    const messages = await readMessages(locale);
    for (const key of requiredKeys) {
      if (!Object.hasOwn(messages, key)) {
        missing.push(`${locale}:${key}`);
        continue;
      }
      const defaultMessage = defaultMessages[key]?.message;
      if (
        typeof defaultMessage === 'string' &&
        defaultMessage.trim() !== '' &&
        (typeof messages[key]?.message !== 'string' || messages[key].message.trim() === '')
      ) {
        empty.push(`${locale}:${key}`);
      }
    }
  }

  assert.deepEqual(missing, []);
  assert.deepEqual(empty, []);
});
