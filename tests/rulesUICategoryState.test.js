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

async function withRulesUI(callback) {
  const previousBrowser = globalThis.browser;
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousDebugController = globalThis.DebugController;
  const extensionApi = {
    storage: {
      sync: {
        get(_keys, done) { done({}); },
        set() {}
      },
      onChanged: { addListener() {} }
    },
    i18n: { getMessage(key) { return key; } }
  };

  globalThis.browser = extensionApi;
  globalThis.chrome = extensionApi;
  globalThis.document = {
    createElement(tagName) { return new FakeElement(tagName); }
  };

  try {
    const { RulesUI } = await import('../rules/rulesUI.js');
    return await callback(new RulesUI());
  } finally {
    globalThis.browser = previousBrowser;
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.DebugController = previousDebugController;
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
    const { RulesUI } = await import('../rules/rulesUI.js');
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
    const { RulesUI } = await import('../rules/rulesUI.js');
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

test('Free rule rows keep an actionable Delete button when Edit is unavailable', async () => {
  await withRulesUI(async rulesUI => {
    const assignment = {
      listId: 'general',
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    };
    const rule = {
      id: 41,
      blockURL: 'free-delete.example',
      redirectURL: '',
      category: 'social',
      isWhitelist: false,
      assignments: [assignment]
    };
    const deletions = [];
    const row = rulesUI.createRuleDisplayRow(
      rule,
      assignment,
      0,
      () => assert.fail('Free deletion must not require Edit access'),
      (_event, ruleId, selectedAssignment) => {
        deletions.push({ ruleId, listId: selectedAssignment.listId });
      },
      () => {},
      false,
      [],
      {},
      true
    );
    const actionsCell = row.children[4];

    assert.equal(actionsCell.children.length, 1);
    const deleteButton = actionsCell.children[0];
    assert.equal(deleteButton.className, 'delete-btn');
    await deleteButton.listeners.get('click')[0]({ target: deleteButton });
    assert.deepEqual(deletions, [{ ruleId: 41, listId: 'general' }]);
  });
});

test('shared Rule List rows bind Delete to the displayed assignment only', async () => {
  await withRulesUI(async rulesUI => {
    const generalAssignment = {
      listId: 'general',
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    };
    const customAssignment = { ...generalAssignment, listId: 'list-1' };
    const rule = {
      id: 53,
      blockURL: 'shared-delete.example',
      redirectURL: '',
      category: 'work',
      isWhitelist: false,
      assignments: [generalAssignment, customAssignment]
    };
    const deletions = [];
    const row = rulesUI.createRuleDisplayRow(
      rule,
      customAssignment,
      0,
      () => {},
      (_event, ruleId, selectedAssignment) => {
        deletions.push({ ruleId, listId: selectedAssignment.listId });
      },
      () => {},
      false,
      [],
      {},
      true
    );
    const deleteButton = row.children[4].children[0];

    assert.equal(row.dataset.assignmentListId, 'list-1');
    assert.equal(deleteButton.textContent, 'rulelists_remove_assignment');
    await deleteButton.listeners.get('click')[0]({ target: deleteButton });
    assert.deepEqual(deletions, [{ ruleId: 53, listId: 'list-1' }]);
  });
});

test('existing whitelist rows retain Delete without exposing Edit controls', async () => {
  await withRulesUI(async rulesUI => {
    const assignment = {
      listId: 'general',
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    };
    const rule = {
      id: 67,
      blockURL: 'allowed.example',
      redirectURL: '',
      category: 'whitelist',
      isWhitelist: true,
      assignments: [assignment]
    };
    const deletions = [];
    const row = rulesUI.createRuleDisplayRow(
      rule,
      assignment,
      0,
      () => assert.fail('Whitelist cleanup must not require Edit access'),
      (_event, ruleId) => deletions.push(ruleId),
      () => {},
      false
    );
    const deleteButton = row.children[4].children[0];

    assert.equal(row.children[4].children.length, 1);
    await deleteButton.listeners.get('click')[0]({ target: deleteButton });
    assert.deepEqual(deletions, [67]);
  });
});
