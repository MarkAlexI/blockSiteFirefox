import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { collectReferencedLocaleKeys } from '../tools/localization-references.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const root = new URL('../', import.meta.url);
const attributes = ['data-i18n', 'data-i18n-placeholder', 'data-i18n-aria-label'];

test('locale validation catches absent English keys in each supported HTML and setAttribute translation', () => {
  const english = { header: { message: 'Rules' } };
  for (const attribute of attributes) {
    for (const source of [
      `<input ${attribute} = 'missing_locale_reference'>`,
      `element.setAttribute('${attribute}', 'missing_locale_reference')`
    ]) {
      const missing = [...collectReferencedLocaleKeys(source)].filter(key => !Object.hasOwn(english, key));
      assert.deepEqual(missing, ['missing_locale_reference'], `${attribute}: ${source}`);
    }
  }
  assert.deepEqual([...collectReferencedLocaleKeys('<input data-i18n-title="unhandled_attribute">')], []);
});

test('every HTML translation reference resolves in the actual default catalog', async () => {
  const english = JSON.parse(await readFile(new URL('_locales/en/messages.json', root), 'utf8'));
  const missing = [];
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'tests', 'tools', 'e2e'].includes(entry.name)) continue;
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith('.html')) {
        const html = await readFile(file, 'utf8');
        for (const key of collectReferencedLocaleKeys(html)) {
          if (!Object.hasOwn(english, key)) missing.push(`${file.pathname}:${key}`);
        }
      }
    }
  }
  await inspect(root);
  assert.deepEqual(missing, []);
});

for (const locale of ['en', 'es', 'es_419']) {
  test(`Options search is localized by the shared initializer alone in ${locale}`, async () => {
    const catalog = JSON.parse(await readFile(new URL(`_locales/${locale}/messages.json`, root), 'utf8'));
    const html = await readFile(new URL('options/options.html', root), 'utf8');
    const markup = html.match(/<input\b(?=[^>]*\bid="search-input")[^>]*>/)?.[0];
    assert.ok(markup, 'test uses the real search input markup');
    const document = new FakeDocument();
    const input = document.addElement('search-input', 'input');
    for (const attribute of attributes) {
      const key = markup.match(new RegExp(`${attribute}="([^"]+)"`))?.[1];
      if (key) input.setAttribute(attribute, key);
    }
    const api = createExtensionApi();
    api.i18n.getMessage = key => catalog[key]?.message || '';
    await withExtensionEnvironment(api, async () => {
      await import(`../scripts/i18n.js?search-catalog=${locale}`);
      assert.equal(input.placeholder, catalog.searchfordomain.message);
      assert.equal(input.getAttribute('aria-label'), catalog.searchfordomain.message);
    }, { document });
  });
}
