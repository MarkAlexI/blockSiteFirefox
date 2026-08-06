import test from 'node:test';
import assert from 'node:assert/strict';

import { CategoryUIManager } from '../options/categoryUIManager.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.type = '';
    this.checked = false;
    this.title = '';
    this.textContent = '';
    this._innerHTML = '';
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  click() {
    if (this.tagName === 'LABEL') {
      const checkbox = this.children.find(
        child => child.tagName === 'INPUT' && child.type === 'checkbox'
      );
      checkbox?.click();
      return;
    }

    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this.checked = !this.checked;
      for (const listener of this.listeners.get('change') || []) {
        listener({ target: this });
      }
    }
  }
}

function createHarness({ disabledCategories = [], rules = [{ category: 'social' }] } = {}) {
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.browser;
  const container = new FakeElement('div');
  const toggles = [];

  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };
  globalThis.browser = {
    i18n: {
      getMessage(key) {
        return key;
      }
    }
  };

  CategoryUIManager.updateCategoryGrid(
    container,
    rules,
    disabledCategories,
    category => toggles.push(category)
  );

  return {
    container,
    toggles,
    restore() {
      globalThis.document = previousDocument;
      globalThis.browser = previousChrome;
    }
  };
}

test('category cards use native label behavior instead of forwarding a second click', () => {
  const harness = createHarness();

  try {
    const socialCard = harness.container.children[0];
    const checkbox = socialCard.children[0];

    assert.equal(socialCard.tagName, 'LABEL');
    assert.equal(checkbox.checked, true);

    checkbox.click();

    assert.equal(checkbox.checked, false);
    assert.deepEqual(harness.toggles, ['social']);
  } finally {
    harness.restore();
  }
});

test('clicking the category card toggles its checkbox exactly once', () => {
  const harness = createHarness({ disabledCategories: ['social'] });

  try {
    const socialCard = harness.container.children[0];
    const checkbox = socialCard.children[0];

    assert.equal(checkbox.checked, false);

    socialCard.click();

    assert.equal(checkbox.checked, true);
    assert.deepEqual(harness.toggles, ['social']);
  } finally {
    harness.restore();
  }
});


test('disabled categories stay visible even when they contain no rules', () => {
  const harness = createHarness({
    disabledCategories: ['news'],
    rules: [{ category: 'social' }]
  });

  try {
    assert.equal(harness.container.children.length, 8);

    const newsCard = harness.container.children[1];
    const newsCheckbox = newsCard.children[0];
    const newsCount = newsCard.children[2];

    assert.equal(newsCard.tagName, 'LABEL');
    assert.match(newsCard.className, /\bmuted\b/);
    assert.equal(newsCheckbox.checked, false);
    assert.equal(newsCount.textContent, 0);
  } finally {
    harness.restore();
  }
});
