import test from 'node:test';
import assert from 'node:assert/strict';

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  add(...tokens) {
    for (const token of tokens) this.values.add(token);
    this.element.className = [...this.values].join(' ');
  }

  contains(token) {
    return this.values.has(token);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.title = '';
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
}

test('a rule in a disabled category remains rendered as inactive and non-interactive', async () => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  const previousDebugController = globalThis.DebugController;

  globalThis.browser = {
    storage: {
      sync: {
        get(_keys, callback) {
          callback({});
        },
        set() {}
      },
      onChanged: {
        addListener() {}
      }
    },
    i18n: {
      getMessage(key) {
        return key;
      }
    }
  };
  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };

  try {
    const { RulesUI } = await import(`../rules/rulesUI.js?test=${Date.now()}`);
    const rulesUI = new RulesUI();
    const rule = {
      id: 17,
      blockURL: 'social.example',
      redirectURL: '',
      category: 'social',
      schedule: null,
      disabledByUser: false,
      isWhitelist: false
    };

    const row = rulesUI.createRuleDisplayRow(
      rule,
      { listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null },
      0,
      () => {},
      () => {},
      () => {},
      true,
      ['social'],
      {}
    );

    assert.equal(row.tagName, 'TR');
    assert.equal(row.dataset.ruleId, 17);
    assert.equal(row.children.length, 5);
    assert.equal(row.classList.contains('category-muted'), true);
    assert.equal(row.title, 'category_disabled_desc');

    const actionsCell = row.children[4];
    assert.equal(actionsCell.children.length, 2);
    assert.equal(actionsCell.children[0].tagName, 'BUTTON');
    assert.equal(actionsCell.children[1].tagName, 'BUTTON');
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.document = previousDocument;
    globalThis.DebugController = previousDebugController;
  }
});


test('strict delete confirmation state is detected without restarting deletion flow', async () => {
  const previousBrowser = globalThis.browser;
  const previousDocument = globalThis.document;
  const previousDebugController = globalThis.DebugController;

  globalThis.browser = {
    storage: {
      sync: {
        get(_keys, callback) { callback({}); },
        set() {}
      },
      onChanged: { addListener() {} }
    },
    i18n: { getMessage(key) { return key; } }
  };
  globalThis.document = {
    createElement(tagName) { return new FakeElement(tagName); }
  };

  try {
    const { RulesUI } = await import(`../rules/rulesUI.js?delete-state=${Date.now()}`);
    const rulesUI = new RulesUI();
    const button = new FakeElement('button');

    assert.equal(rulesUI.isDeleteConfirmationInProgress(button), false);

    button.classList.add('countdown-active');
    assert.equal(rulesUI.isDeleteConfirmationInProgress(button), true);

    button.classList.values.delete('countdown-active');
    button.classList.add('delete-ready');
    assert.equal(rulesUI.isDeleteConfirmationInProgress(button), true);
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.document = previousDocument;
    globalThis.DebugController = previousDebugController;
  }
});
