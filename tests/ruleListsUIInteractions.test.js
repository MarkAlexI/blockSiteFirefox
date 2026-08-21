import test from 'node:test';
import assert from 'node:assert/strict';

import { RuleListsUI, resolveRuleListContext } from '../options/ruleListsUI.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const lists = [
  { id: 'general', name: 'General', disabledCategories: [] },
  { id: 'list-1', name: 'Work', disabledCategories: ['social'] }
];

test('Rule List cards count blacklist assignments only and fall back to the General profile', async () => {
  const document = new FakeDocument();
  await withExtensionEnvironment(createExtensionApi(), () => {
    const container = document.addElement('lists');
    container.appendChild(document.createElement('p'));
    RuleListsUI.updateListGrid(container, lists, [
      { isWhitelist: false, assignments: [{ listId: 'general' }, { listId: 'list-1' }] },
      { isWhitelist: false, assignments: [{ listId: 'list-1' }] },
      { isWhitelist: true, assignments: [{ listId: 'general' }] }
    ], { activeRuleListId: 'deleted-profile' });

    assert.equal(container.children.length, 2);
    assert.equal(container.children[0].children[0].checked, true);
    assert.equal(container.children[0].children[2].textContent, 1);
    assert.equal(container.children[1].children[2].textContent, 2);
    assert.equal(container.children[0].querySelector('.rule-list-actions'), null);
    assert.equal(container.children[0].children[1].textContent, 'rulelist_general');
  }, { document });
});

test('Rule List selectors and names switch profiles only when the requested selector is checked', async () => {
  const document = new FakeDocument();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    const selected = [];
    const container = document.addElement('lists');
    RuleListsUI.updateListGrid(container, lists, [], {
      activeRuleListId: 'general',
      onSelect(listId) { selected.push(listId); }
    });
    const custom = container.children[1];
    const selector = custom.children[0];
    selector.checked = false;
    await selector.dispatch('change');
    assert.deepEqual(selected, []);

    selector.checked = true;
    await selector.dispatch('change');
    await custom.children[1].dispatch('click');
    assert.deepEqual(selected, ['list-1', 'list-1']);
    assert.equal(selector.getAttribute('aria-label'), 'Work');
  }, { document });
});

test('custom Rule Lists expose Rename and Delete handlers while General remains protected', async () => {
  const document = new FakeDocument();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    const renamed = [];
    const deleted = [];
    const container = document.addElement('lists');
    RuleListsUI.updateListGrid(container, lists, [], {
      activeRuleListId: 'list-1',
      onRename(list) { renamed.push(list.id); },
      onDelete(list) { deleted.push(list.id); }
    });
    const actions = container.children[1].querySelector('.rule-list-actions');
    await actions.children[0].dispatch('click');
    await actions.children[1].dispatch('click');

    assert.deepEqual(renamed, ['list-1']);
    assert.deepEqual(deleted, ['list-1']);
    assert.equal(container.children[1].children[1].getAttribute('aria-current'), 'true');
    assert.equal(RuleListsUI.getDisplayName(lists[0]), 'rulelist_general');
    assert.equal(RuleListsUI.getDisplayName(lists[1]), 'Work');
  }, { document });
});

test('profile resolution rejects missing lists and accepts only explicitly known profile identifiers', () => {
  assert.equal(resolveRuleListContext(null, 'list-1'), 'general');
  assert.equal(resolveRuleListContext([], 'list-1'), 'general');
  assert.equal(resolveRuleListContext(lists, 'list-1'), 'list-1');
  assert.equal(resolveRuleListContext(lists, '__proto__'), 'general');
});
