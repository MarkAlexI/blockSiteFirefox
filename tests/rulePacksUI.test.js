import test from 'node:test';
import assert from 'node:assert/strict';
import { RulePacksUI } from '../options/rulePacksUI.js';

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  add(...values) {
    values.forEach(value => this.values.add(value));
  }
  remove(...values) {
    values.forEach(value => this.values.delete(value));
  }
  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.className = '';
    this.value = '';
    this.textContent = '';
    this.type = '';
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.open = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ target: this, preventDefault() {} });
    }
  }

  appendChild(child) {
    this.children.push(child);
    if (this.tagName === 'SELECT' && !this.value) this.value = child.value;
    return child;
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  replaceChildren(...children) {
    this.children = [...children];
    if (this.tagName === 'SELECT') this.value = children[0]?.value || '';
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = element => {
      if (selector === 'input[type="checkbox"]' && element.tagName === 'INPUT' && element.type === 'checkbox') {
        matches.push(element);
      }
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

function createHarness() {
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.browser;
  const elements = {
    dialog: new FakeElement('dialog'),
    openButton: new FakeElement('button'),
    closeButton: new FakeElement('button'),
    cancelButton: new FakeElement('button'),
    addButton: new FakeElement('button'),
    packSelect: new FakeElement('select'),
    description: new FakeElement('p'),
    category: new FakeElement('span'),
    selectAll: new FakeElement('input'),
    entriesContainer: new FakeElement('div'),
    status: new FakeElement('p')
  };
  elements.selectAll.type = 'checkbox';
  elements.status.classList.add('hidden');
  const additions = [];

  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };
  globalThis.browser = {
    i18n: {
      getMessage(key, substitutions) {
        if (key === 'rulepacks_result') return substitutions.join('|');
        return key;
      }
    }
  };

  const ui = new RulePacksUI({
    ...elements,
    onAdd: async (packId, entryIds) => {
      additions.push({ packId, entryIds });
      return { addedCount: entryIds.length, skippedDuplicates: 0, conflicts: [] };
    }
  });
  ui.initialize();

  return {
    ui,
    elements,
    additions,
    restore() {
      globalThis.document = previousDocument;
      globalThis.browser = previousChrome;
    }
  };
}

test('rule pack UI previews all entries and keeps selection explicit', () => {
  const harness = createHarness();

  try {
    assert.equal(harness.elements.packSelect.children.length, 5);
    assert.equal(harness.elements.entriesContainer.children.length, 8);
    assert.equal(harness.ui.getSelectedEntryIds().length, 8);
    assert.equal(harness.elements.addButton.disabled, false);

    harness.elements.selectAll.checked = false;
    harness.elements.selectAll.dispatch('change');

    assert.deepEqual(harness.ui.getSelectedEntryIds(), []);
    assert.equal(harness.elements.addButton.disabled, true);
  } finally {
    harness.restore();
  }
});

test('rule pack UI sends only selected entry IDs', async () => {
  const harness = createHarness();

  try {
    const checkboxes = harness.ui.getEntryCheckboxes();
    checkboxes.slice(1).forEach(checkbox => {
      checkbox.checked = false;
    });
    harness.ui.updateSelectionState();

    await harness.ui.addSelected();

    assert.deepEqual(harness.additions, [{
      packId: 'social',
      entryIds: ['facebook']
    }]);
    assert.equal(harness.elements.status.textContent, '1|0|0');
    assert.equal(harness.elements.status.classList.contains('success'), true);
  } finally {
    harness.restore();
  }
});
