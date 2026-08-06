import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredKeys = [
  'diagnosticstitle',
  'diagnosticsdesc',
  'diagnosticsdebugnotice',
  'diagnosticsgenerate',
  'diagnosticscopy',
  'diagnosticsexport',
  'diagnosticsclear',
  'diagnosticsempty',
  'diagnosticsgenerated',
  'diagnosticscopied',
  'diagnosticsexported',
  'diagnosticscleared',
  'diagnosticserror',
  'diagnosticsconfirmclear'
];

test('all locales contain complete Diagnostics interface strings', async () => {
  const localesRoot = path.join(root, '_locales');
  const locales = await readdir(localesRoot, { withFileTypes: true });
  let checked = 0;

  for (const locale of locales) {
    if (!locale.isDirectory()) continue;
    const file = path.join(localesRoot, locale.name, 'messages.json');
    const messages = JSON.parse(await readFile(file, 'utf8'));

    for (const key of requiredKeys) {
      assert.equal(
        typeof messages[key]?.message,
        'string',
        `${locale.name}: missing ${key}`
      );
      assert.notEqual(messages[key].message.trim(), '', `${locale.name}: empty ${key}`);
    }
    checked++;
  }

  assert.equal(checked, 57);
});
