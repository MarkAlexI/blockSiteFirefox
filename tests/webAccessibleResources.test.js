import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const publicResources = manifest.web_accessible_resources
  .filter(group => group.matches?.length)
  .flatMap(group => group.resources).sort();

test('websites can access only the blocking and redirect entry pages', () => {
  assert.deepEqual(publicResources, ['blocked.html', 'redirect.html']);
});

test('private blocking assets and permission setup remain available in the runtime', async () => {
  for (const resource of ['styles/blocked.css', 'scripts/blocked.js',
    'styles/redirect.css', 'scripts/redirect.js', 'onboarding/onboarding.html',
    'onboarding/onboarding.css', 'onboarding/onboarding.js']) {
    assert.equal(publicResources.includes(resource), false, resource + ' stays private');
    assert.equal((await stat(new URL(resource, root))).isFile(), true, resource + ' remains packaged');
  }
});
