import test from 'node:test';
import assert from 'node:assert/strict';

class FakeClassList {
  constructor(element) { this.element = element; this.values = new Set(); }
  add(...tokens) { for (const token of tokens) this.values.add(token); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.type = '';
    this.title = '';
    this.innerHTML = '';
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
}

test('rule list grid renders General and custom list counts', async () => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  globalThis.browser = { i18n: { getMessage(key) { return key === 'rulelist_general' ? 'General' : key; } } };
  globalThis.document = { createElement(tag) { return new FakeElement(tag); } };

  try {
    const { RuleListsUI } = await import(`../options/ruleListsUI.js?test=${Date.now()}`);
    const container = new FakeElement('div');
    RuleListsUI.updateListGrid(
      container,
      [
        { id: 'general', name: 'General', disabled: false },
        { id: 'list-1', name: 'Work', disabled: true }
      ],
      [
        { listId: 'general', isWhitelist: false },
        { listId: 'list-1', isWhitelist: false },
        { listId: 'list-1', isWhitelist: false },
        { listId: 'general', isWhitelist: true }
      ]
    );

    assert.equal(container.children.length, 2);
    assert.equal(container.children[0].dataset.listId, 'general');
    assert.equal(container.children[0].children[0].children[1].textContent, 'General');
    assert.equal(container.children[0].children[0].children[2].textContent, 1);
    assert.equal(container.children[1].children[0].children[2].textContent, 2);
    assert.match(container.children[1].className, /muted/);
    assert.equal(container.children[1].children[1].children.length, 2);
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.document = previousDocument;
  }
});

test('rule list filter preserves a valid selection and falls back to all', async () => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  globalThis.browser = { i18n: { getMessage(key) { return key; } } };
  globalThis.document = { createElement(tag) { return new FakeElement(tag); } };

  try {
    const { RuleListsUI } = await import(`../options/ruleListsUI.js?filter=${Date.now()}`);
    const select = new FakeElement('select');
    RuleListsUI.updateFilter(select, [
      { id: 'general', name: 'General' },
      { id: 'list-1', name: 'Work' }
    ], 'list-1');
    assert.equal(select.children.length, 3);
    assert.equal(select.value, 'list-1');

    RuleListsUI.updateFilter(select, [{ id: 'general', name: 'General' }], 'list-1');
    assert.equal(select.value, 'all');
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.document = previousDocument;
  }
});
