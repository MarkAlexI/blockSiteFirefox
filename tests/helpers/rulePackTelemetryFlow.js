import { RulePacksUI } from '../../options/rulePacksUI.js';
import { RulesClient } from '../../rules/rulesClient.js';
import { DialogTestDocument } from './dialogTestDocument.js';

// Real UI, rules client, worker, store and HTTP serializer. Only DOM/browser
// APIs and the final HTTP response are modeled; no counter is injected here.
export async function withRulePackTelemetryFlow({ api, sendRaw }, run) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalSend = api.runtime.sendMessage;
  const pending = [];
  const document = new DialogTestDocument();
  globalThis.document = document;
  const tags = {
    dialog: 'dialog', openButton: 'button', closeButton: 'button', cancelButton: 'button',
    addButton: 'button', packSelect: 'select', description: 'p', category: 'span',
    selectAll: 'input', entriesContainer: 'div', status: 'div', announcement: 'p'
  };
  const elements = Object.fromEntries(Object.entries(tags).map(([name, tag]) => [name, document.createElement(tag)]));
  document.body.append(elements.openButton, elements.dialog);
  for (const [name, element] of Object.entries(elements)) {
    element.id = name;
    if (!['dialog', 'openButton'].includes(name)) elements.dialog.append(element);
  }
  elements.selectAll.type = 'checkbox';
  api.runtime.sendMessage = (message, callback) => {
    if (!['rules:addMany', 'telemetry:incrementCounter'].includes(message.type)) {
      return originalSend.call(api.runtime, message, callback);
    }
    const task = sendRaw(structuredClone(message), {
      id: api.runtime.id, url: api.runtime.getURL('options/options.html')
    });
    pending.push(task);
    if (typeof callback === 'function') task.then(callback);
    return task;
  };
  const client = new RulesClient();
  const ui = new RulePacksUI({
    ...elements,
    getListContext: () => ({
      listId: api.storage.local.data.activeRuleListId,
      generation: api.storage.local.data.rulesGeneration ?? null,
      revisions: { ...api.storage.local.data.ruleListRevisions }
    }),
    onAdd: (packId, entryIds, schedule, context) => client.addMany(
      packId, entryIds, schedule, context.listId, context.generation, context.revisions
    )
  });
  const settle = () => Promise.all(pending);
  try {
    ui.initialize();
    await run({
      ui, elements, settle,
      async open(entries = ['youtube', 'vimeo']) {
        await elements.openButton.dispatch('click');
        elements.packSelect.value = 'video';
        await elements.packSelect.dispatch('change');
        elements.selectAll.checked = false;
        await elements.selectAll.dispatch('change');
        for (const checkbox of ui.getEntryCheckboxes()) {
          if (!entries.includes(checkbox.value)) continue;
          checkbox.checked = true;
          await checkbox.dispatch('change');
        }
        await settle();
      },
      async add() {
        await elements.addButton.dispatch('click');
        await settle();
      }
    });
    await settle();
  } finally {
    api.runtime.sendMessage = originalSend;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  }
}
