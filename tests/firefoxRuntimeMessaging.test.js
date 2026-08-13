import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FILES = [
  'options/goPro.js',
  'onboarding/onboarding.js',
  'scripts/blocked.js',
  'scripts/redirect.js',
  'scripts/service_worker.js',
  'update/update.js'
];

test('Firefox runtime messaging avoids Chromium callback-style sendMessage usage', async () => {
  for (const file of FILES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(
      /browser\.runtime\.sendMessage\([\s\S]{0,300}?,\s*\([^)]*\)\s*=>/.test(source),
      false,
      `${file} must use the Promise-returning browser.runtime.sendMessage form`
    );
  }
});

test('Firefox request-response helper no longer reads runtime.lastError', async () => {
  const source = await readFile(new URL('../options/goPro.js', import.meta.url), 'utf8');
  assert.equal(source.includes('browser.runtime.lastError'), false);
  assert.match(source, /await browser\.runtime\.sendMessage\(message\)/);
});
