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
    this.name = '';
    this.title = '';
    this.innerHTML = '';
    this.attributes = new Map();
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

test('rule list grid renders profile counts and marks exactly one active profile', async () => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  globalThis.browser = { i18n: { getMessage(key) { return key === 'rulelist_general' ? 'General' : key; } } };
  globalThis.document = { createElement(tag) { return new FakeElement(tag); } };

  try {
    const { RuleListsUI } = await import('../options/ruleListsUI.js');
    const container = new FakeElement('div');
    const selected = [];
    RuleListsUI.updateListGrid(
      container,
      [
        { id: 'general', name: 'General', disabledCategories: [] },
        { id: 'list-1', name: 'Work', disabledCategories: ['social'] },
        { id: 'list-2', name: 'Study', disabledCategories: [] }
      ],
      [
        { assignments: [{ listId: 'general', blockingMode: 'always' }], isWhitelist: false },
        { assignments: [{ listId: 'list-1', blockingMode: 'always' }, { listId: 'list-2', blockingMode: 'always' }], isWhitelist: false },
        { assignments: [{ listId: 'list-1', blockingMode: 'always' }], isWhitelist: false }
      ],
      { activeRuleListId: 'list-2', onSelect: listId => selected.push(listId) }
    );

    assert.equal(container.children.length, 3);
    assert.equal(container.children[0].children[0].type, 'radio');
    assert.equal(container.children[0].children[2].textContent, 1);
    assert.equal(container.children[1].children[2].textContent, 2);
    assert.equal(container.children[2].children[2].textContent, 1);
    assert.equal(container.children[2].children[0].checked, true);
    assert.match(container.children[2].className, /selected/);
    assert.equal(container.children[2].children[1].getAttribute('aria-current'), 'true');

    container.children[1].children[1].listeners.get('click')();
    assert.deepEqual(selected, ['list-1']);
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.document = previousDocument;
  }
});

test('resolveRuleListContext uses only known profiles', async () => {
  const previousApi = globalThis.browser;
  globalThis.browser = { i18n: { getMessage(key) { return key; } } };
  try {
    const { resolveRuleListContext } = await import('../options/ruleListsUI.js');
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
