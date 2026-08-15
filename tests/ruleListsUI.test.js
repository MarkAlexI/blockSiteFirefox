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
    this.attributes = new Map();
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

test('rule list grid renders shared membership counts and selectable list names', async () => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  globalThis.browser = { i18n: { getMessage(key) { return key === 'rulelist_general' ? 'General' : key; } } };
  globalThis.document = { createElement(tag) { return new FakeElement(tag); } };

  try {
    const { RuleListsUI } = await import(`../options/ruleListsUI.js?test=${Date.now()}`);
    const container = new FakeElement('div');
    const selected = [];
    RuleListsUI.updateListGrid(
      container,
      [
        { id: 'general', name: 'General', disabled: false },
        { id: 'list-1', name: 'Work', disabled: true },
        { id: 'list-2', name: 'Study', disabled: false }
      ],
      [
        { listIds: ['general'], isWhitelist: false },
        { listIds: ['list-1', 'list-2'], isWhitelist: false },
        { listIds: ['list-1'], isWhitelist: false },
        { listIds: ['general'], isWhitelist: true }
      ],
      { selectedListId: 'list-2', onSelect: listId => selected.push(listId) }
    );

    assert.equal(container.children.length, 3);
    assert.equal(container.children[0].dataset.listId, 'general');
    assert.equal(container.children[0].children[1].textContent, 'General');
    assert.equal(container.children[0].children[2].textContent, 1);
    assert.equal(container.children[1].children[2].textContent, 2);
    assert.equal(container.children[2].children[2].textContent, 1);
    assert.match(container.children[1].className, /muted/);
    assert.equal(container.children[1].children[3].children.length, 2);
    assert.match(container.children[2].className, /selected/);
    assert.equal(container.children[2].children[1].getAttribute('aria-current'), 'true');

    container.children[2].children[1].listeners.get('click')();
    assert.deepEqual(selected, ['list-2']);
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


test('resolveRuleListContext uses the selected list as the add context', async () => {
  const previousApi = globalThis.browser;
  globalThis.browser = { i18n: { getMessage(key) { return key; } } };
  try {
    const { resolveRuleListContext } = await import(`../options/ruleListsUI.js?context=${Date.now()}`);
    const lists = [
      { id: 'general', name: 'General' },
      { id: 'list-1', name: 'Study' }
    ];
    assert.equal(resolveRuleListContext(lists, 'list-1'), 'list-1');
    assert.equal(resolveRuleListContext(lists, 'all'), 'general');
    assert.equal(resolveRuleListContext(lists, 'missing'), 'general');
  } finally {
    globalThis.browser = previousApi;
  }
});
