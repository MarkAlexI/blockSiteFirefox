import test from 'node:test';
import assert from 'node:assert/strict';

class FakeClassList {
  constructor(element) { this.element = element; this.values = new Set(); }
  add(...tokens) { for (const token of tokens) this.values.add(token); }
  contains(token) { return this.values.has(token); }
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
    this.disabled = false;
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute() {}
}

function findTags(root, tagName, found = []) {
  if (root?.tagName === tagName.toUpperCase()) found.push(root);
  for (const child of root?.children || []) findTags(child, tagName, found);
  return found;
}

test('assignment edit context shows a fixed list badge instead of a membership selector', async () => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  globalThis.browser = {
    storage: { sync: { get(_keys, cb) { cb({}); }, set() {} }, onChanged: { addListener() {} } },
    i18n: { getMessage(key) { return key === 'rulelist_header' ? 'List' : key; } }
  };
  globalThis.document = {
    createElement(tag) { return new FakeElement(tag); }
  };

  try {
    const { RulesUI } = await import(`../rules/rulesUI.js?assignment-context=${Date.now()}`);
    const ui = new RulesUI();
    const context = ui.createRuleListContext([
      { id: 'general', name: 'General' },
      { id: 'list-2', name: 'Study' }
    ], 'list-2', false);

    assert.equal(context._listId, 'list-2');
    assert.equal(findTags(context, 'select').length, 0);
    assert.equal(context.children[0].textContent, 'List');
    assert.equal(context.children[1].textContent, 'Study');
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.document = previousDocument;
  }
});

test('All Lists add context still exposes an explicit list selector', async () => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  globalThis.browser = {
    storage: { sync: { get(_keys, cb) { cb({}); }, set() {} }, onChanged: { addListener() {} } },
    i18n: { getMessage(key) { return key; } }
  };
  globalThis.document = { createElement(tag) { return new FakeElement(tag); } };

  try {
    const { RulesUI } = await import(`../rules/rulesUI.js?assignment-selector=${Date.now()}`);
    const ui = new RulesUI();
    const editor = ui.createRuleListEditor([
      { id: 'general', name: 'General' },
      { id: 'list-2', name: 'Study' }
    ], 'list-2');

    const selects = findTags(editor, 'select');
    assert.equal(selects.length, 1);
    assert.equal(ui.getRuleListIdFromEditor(editor), 'list-2');
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.document = previousDocument;
  }
});
