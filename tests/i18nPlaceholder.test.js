import test from 'node:test';
import assert from 'node:assert/strict';

test('i18n module translates data-i18n-placeholder attributes', async () => {
  const previousApi = globalThis.browser;
  const previousDocument = globalThis.document;
  const input = {
    placeholder: 'New list name',
    getAttribute(name) {
      return name === 'data-i18n-placeholder' ? 'rulelists_name_placeholder' : null;
    }
  };

  globalThis.browser = {
    i18n: {
      getMessage(key) {
        return key === 'rulelists_name_placeholder' ? 'Localized list name' : key;
      }
    }
  };
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === '[data-i18n-placeholder]') return [input];
      return [];
    }
  };

  try {
    await import(`../scripts/i18n.js?placeholder=${Date.now()}`);
    assert.equal(input.placeholder, 'Localized list name');
  } finally {
    globalThis.browser = previousApi;
    globalThis.document = previousDocument;
  }
});
