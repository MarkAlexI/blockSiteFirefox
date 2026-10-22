import test from 'node:test';
import assert from 'node:assert/strict';
import { RulePacksUI } from '../options/rulePacksUI.js';

import { DialogTestDocument } from './helpers/dialogTestDocument.js';

function createHarness({ resultFactory, schedule = null, getListContext = null } = {}) {
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.browser;
  const telemetryMessages = [];
  const document = new DialogTestDocument();
  const elements = {
    dialog: document.createElement('dialog'),
    openButton: document.createElement('button'),
    closeButton: document.createElement('button'),
    cancelButton: document.createElement('button'),
    addButton: document.createElement('button'),
    packSelect: document.createElement('select'),
    description: document.createElement('p'),
    category: document.createElement('span'),
    selectAll: document.createElement('input'),
    entriesContainer: document.createElement('div'),
    scheduleContainer: document.createElement('div'),
    status: document.createElement('p'),
    announcement: document.createElement('p')
  };
  document.body.append(elements.openButton, elements.dialog);
  for (const [key, element] of Object.entries(elements)) {
    element.id = key;
    if (key !== 'openButton' && key !== 'dialog') elements.dialog.appendChild(element);
  }
  elements.selectAll.type = 'checkbox';
  elements.status.classList.add('hidden');
  const additions = [];
  const scheduleSection = document.createElement('div');
  const scheduleCreateCalls = [];
  let scheduleDialogOpen = false;
  let scheduleCloseCalls = 0;
  const scheduleEditor = {
    createSection(existingSchedule, enableSchedule, options) {
      scheduleCreateCalls.push({ existingSchedule, enableSchedule, options });
      return scheduleSection;
    },
    getSchedule(section) {
      assert.equal(section, scheduleSection);
      return schedule;
    },
    isDialogOpen() {
      return scheduleDialogOpen;
    },
    closeDialog() {
      scheduleCloseCalls++;
      scheduleDialogOpen = false;
    }
  };

  globalThis.document = document;
  globalThis.browser = {
    runtime: {
      sendMessage(message) {
        telemetryMessages.push(structuredClone(message));
        return Promise.resolve({ success: true });
      }
    },
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
    scheduleEditor, getListContext,
    onAdd: async (packId, entryIds, selectedSchedule, context) => {
      additions.push({ packId, entryIds, schedule: selectedSchedule, ...(context ? { context: structuredClone(context) } : {}) });
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
    document,
    elements,
    additions,
    telemetryMessages,
    scheduleCreateCalls,
    setScheduleDialogOpen(value) {
      scheduleDialogOpen = value;
    },
    getScheduleCloseCalls() {
      return scheduleCloseCalls;
    },
    restore() {
      globalThis.document = previousDocument;
      globalThis.browser = previousChrome;
    }
  };
}

test('opening Rule Packs reports only the fixed dialog counter', () => {
  const harness = createHarness();

  try {
    harness.ui.open();

    assert.equal(harness.elements.dialog.open, true);
    assert.deepEqual(harness.telemetryMessages, [{
      type: 'telemetry:incrementCounter',
      name: 'rule_pack_dialog_opened'
    }]);
  } finally {
    harness.restore();
  }
});


test('rule pack schedule editor is hosted inside the Rule Packs modal', () => {
  const harness = createHarness();

  try {
    const latestCall = harness.scheduleCreateCalls.at(-1);
    assert.equal(latestCall.existingSchedule, null);
    assert.equal(latestCall.enableSchedule, true);
    assert.equal(latestCall.options.dialogHost, harness.elements.dialog);
  } finally {
    harness.restore();
  }
});

test('Escape closes the nested schedule editor before the Rule Packs modal', () => {
  const harness = createHarness();

  try {
    harness.elements.dialog.open = true;
    harness.setScheduleDialogOpen(true);
    harness.elements.dialog.dispatch('cancel');

    assert.equal(harness.getScheduleCloseCalls() > 0, true);
    assert.equal(harness.elements.dialog.open, true);
  } finally {
    harness.restore();
  }
});

test('rule pack UI previews all entries and keeps selection explicit', () => {
  const harness = createHarness();

  try {
    assert.equal(harness.elements.packSelect.children.length, 8);
    assert.equal(harness.elements.entriesContainer.children.length, 11);
    assert.equal(harness.ui.getSelectedEntryIds().length, 11);
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

test('Rule Pack open captures destination/markers through replacement and recaptures only after closing', async () => {
  let context = { listId: 'list-1', generation: 'shown', revisions: { 'list-1': 'revision' } };
  const harness = createHarness({ getListContext: () => context });
  try {
    harness.ui.open();
    context.revisions['list-1'] = 'changed-in-place';
    context = { listId: 'list-2', generation: 'imported', revisions: { 'list-2': 'new' } };
    harness.ui.open();
    await harness.ui.addSelected();
    assert.deepEqual(harness.additions[0].context, { listId: 'list-1', generation: 'shown', revisions: { 'list-1': 'revision' } });
    harness.ui.close(); harness.ui.open(); await harness.ui.addSelected();
    assert.deepEqual(harness.additions[1].context, context);
  } finally { harness.restore(); }
});

test('completion from a closed Rule Pack dialog cannot overwrite a newly opened dialog', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const harness = createHarness({ resultFactory: () => gate });
  try {
    harness.ui.open(); const pending = harness.ui.addSelected();
    harness.ui.close(); harness.ui.open();
    release({ addedCount: 1 }); await pending;
    assert.equal(harness.elements.status.textContent, '');
    assert.equal(harness.elements.status.classList.contains('hidden'), true);
  } finally { harness.restore(); }
});

test('Rule Packs focuses its named selection and restores the opener after external close', async () => {
  const h = createHarness();
  try {
    h.elements.openButton.focus();
    h.ui.open();
    assert.equal(h.document.activeElement.id, 'packSelect');
    h.elements.dialog.close();
    await Promise.resolve();
    assert.equal(h.document.activeElement.id, 'openButton');
    assert.equal(h.ui.listContext, null);
    h.ui.open();
    await Promise.resolve();
    assert.equal(h.elements.dialog.open, true);
    h.ui.close();
  } finally { h.restore(); }
});

test('changing selection and reopening cannot submit a second Rule Pack while the first is pending', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = createHarness({ resultFactory: () => gate });
  try {
    h.ui.open();
    h.elements.addButton.focus();
    const pending = h.ui.addSelected();
    assert.equal(h.document.activeElement.id, 'cancelButton');
    h.ui.toggleAllEntries();
    assert.equal(h.elements.addButton.disabled, true);
    await h.ui.addSelected();
    h.ui.close(); h.ui.open();
    await h.ui.addSelected();
    assert.equal(h.additions.length, 1);
    assert.equal(h.elements.addButton.disabled, true);
    release({ addedCount: 1, syncPending: true });
    await pending;
    assert.equal(h.elements.announcement.textContent, '');
    assert.equal(h.elements.status.classList.contains('hidden'), true);
    assert.equal(h.elements.addButton.disabled, false);
    h.ui.close();
  } finally { h.restore(); }
});

test('Rule Pack announces a concise saved/pending summary once and retains its detailed counts', async () => {
  const h = createHarness({ resultFactory: () => ({ addedCount: 1, syncPending: true,
    addedEntries: [{ blockURL: 'saved.example' }], skippedDuplicates: 2 }) });
  try {
    h.ui.open();
    await h.ui.addSelected();
    assert.match(h.elements.announcement.textContent, /1\|2\|0/);
    assert.match(h.elements.announcement.textContent, /ruleschangessavedpending/);
    assert.doesNotMatch(h.elements.announcement.textContent, /saved\.example/);
    assert.equal(h.elements.status.children[1].children[0].children[1].textContent, '1');
    assert.equal(h.additions.length, 1);
    h.ui.close();
  } finally { h.restore(); }
});
