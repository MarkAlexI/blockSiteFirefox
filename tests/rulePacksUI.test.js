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

function createHarness({ resultFactory, schedule = null } = {}) {
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
    scheduleContainer: new FakeElement('div'),
    status: new FakeElement('p')
  };
  elements.selectAll.type = 'checkbox';
  elements.status.classList.add('hidden');
  const additions = [];
  const scheduleSection = new FakeElement('div');
  const scheduleEditor = {
    createSection() {
      return scheduleSection;
    },
    getSchedule(section) {
      assert.equal(section, scheduleSection);
      return schedule;
    }
  };

  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };
  globalThis.browser = {
    i18n: {
      getMessage(key, substitutions) {
        if (key === 'rulepacks_result') return substitutions.join('|');
        const messages = {
          rulepacks_added_label: 'Added',
          rulepacks_duplicates_label: 'Already added',
          rulepacks_conflicts_label: 'Whitelist conflicts',
          rulepacks_no_new_rules: 'No new rules'
        };
        return messages[key] || key;
      }
    }
  };

  const ui = new RulePacksUI({
    ...elements,
    scheduleEditor,
    onAdd: async (packId, entryIds, selectedSchedule) => {
      additions.push({ packId, entryIds, schedule: selectedSchedule });
      if (typeof resultFactory === 'function') {
        return resultFactory(packId, entryIds);
      }
      return {
        addedCount: entryIds.length,
        skippedDuplicates: 0,
        addedEntries: entryIds.map(entryId => ({ entryId, blockURL: `${entryId}.example` })),
        duplicateEntries: [],
        conflicts: []
      };
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
      entryIds: ['facebook'],
      schedule: null
    }]);
    assert.equal(harness.elements.status.children[0].textContent, '1|0|0');
    assert.equal(harness.elements.status.children[1].children.length, 3);
    assert.equal(harness.elements.status.children[2].children.length, 1);
    assert.equal(harness.elements.status.children[2].children[0].children[1].children[0].textContent, 'facebook.example');
    assert.equal(harness.elements.status.classList.contains('success'), true);
  } finally {
    harness.restore();
  }
});


test('rule pack UI shows detailed added, duplicate, and conflict results', async () => {
  const harness = createHarness({
    resultFactory: () => ({
      addedCount: 1,
      skippedDuplicates: 1,
      addedEntries: [{ entryId: 'temu', blockURL: 'temu.com' }],
      duplicateEntries: [{ entryId: 'amazon', blockURL: 'amazon.com' }],
      conflicts: [{ entryId: 'etsy', blockURL: 'etsy.com', code: 'conflict_whitelist' }]
    })
  });

  try {
    await harness.ui.addSelected();

    const [summary, counts, details] = harness.elements.status.children;
    assert.equal(summary.textContent, '1|1|1');
    assert.deepEqual(
      counts.children.map(item => [item.children[0].textContent, item.children[1].textContent]),
      [
        ['Added', '1'],
        ['Already added', '1'],
        ['Whitelist conflicts', '1']
      ]
    );
    assert.equal(details.children.length, 3);
    assert.deepEqual(
      details.children.map(group => [
        group.children[0].textContent,
        group.children[1].children[0].textContent
      ]),
      [
        ['Added', 'temu.com'],
        ['Already added', 'amazon.com'],
        ['Whitelist conflicts', 'etsy.com']
      ]
    );
  } finally {
    harness.restore();
  }
});

test('rule pack UI keeps count-only compatibility with older worker responses', () => {
  const harness = createHarness();

  try {
    harness.ui.showResultReport({
      addedCount: 0,
      skippedDuplicates: 2,
      conflicts: []
    });

    const [summary, counts] = harness.elements.status.children;
    assert.equal(summary.textContent, 'No new rules');
    assert.deepEqual(
      counts.children.map(item => item.children[1].textContent),
      ['0', '2', '0']
    );
    assert.equal(harness.elements.status.children.length, 2);
  } finally {
    harness.restore();
  }
});

test('rule pack UI sends one shared schedule with the selected entries', async () => {
  const schedule = {
    version: 2,
    periods: [
      { days: [1, 2, 3, 4, 5], startTime: '08:30', endTime: '17:30' },
      { days: [6], startTime: '10:00', endTime: '13:00' }
    ]
  };
  const harness = createHarness({ schedule });

  try {
    await harness.ui.addSelected();

    assert.equal(harness.additions.length, 1);
    assert.equal(harness.additions[0].packId, 'social');
    assert.deepEqual(harness.additions[0].schedule, schedule);
    assert.equal(harness.elements.scheduleContainer.children.length, 1);
  } finally {
    harness.restore();
  }
});

