import test from 'node:test';
import assert from 'node:assert/strict';
import { configureUrlInput } from '../dom/urlInput.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

for (const [locale, direction, expected] of [['uk_UA', 'ltr', 'uk-UA'], ['ar', 'rtl', 'ar']]) {
  test(`native locale ${locale} sets document language and direction without replacing controls`, async () => {
    const document = new FakeDocument();
    const button = document.addElement('localized-action', 'button');
    button.setAttribute('data-i18n-aria-label', 'cancelbtn');
    const icon = document.createElement('span');
    icon.textContent = '×'; button.appendChild(icon);
    const api = createExtensionApi();
    api.i18n.getMessage = key => ({ '@@ui_locale': locale, '@@bidi_dir': direction, cancelbtn: 'Localized cancel' }[key] || key);
    await withExtensionEnvironment(api, async () => {
      await import(`../scripts/i18n.js?document-locale=${locale}`);
      assert.equal(document.documentElement.lang, expected);
      assert.equal(document.documentElement.dir, direction);
      assert.equal(button.getAttribute('aria-label'), 'Localized cancel');
      assert.equal(button.children[0], icon);
    }, { document });
  });
}

test('missing native locale metadata preserves existing valid document metadata', async () => {
  const document = new FakeDocument();
  document.documentElement.lang = 'en-US'; document.documentElement.dir = 'ltr';
  await withExtensionEnvironment(createExtensionApi(), async () => {
    await import('../scripts/i18n.js?document-locale=missing');
    assert.equal(document.documentElement.lang, 'en-US');
    assert.equal(document.documentElement.dir, 'ltr');
  }, { document });
});

test('URL fields keep an LTR editing direction inside an RTL document without changing their value', () => {
  const document = new FakeDocument();
  document.documentElement.dir = 'rtl';
  const input = document.createElement('input');
  input.value = 'example.test/path?x=1';
  configureUrlInput(input);
  assert.equal(input.dir, 'ltr');
  assert.equal(input.value, 'example.test/path?x=1');
  assert.equal(document.documentElement.dir, 'rtl');
});
