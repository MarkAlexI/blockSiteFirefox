import { t } from '../scripts/t.js';
import { GENERAL_RULE_LIST_ID } from '../rules/ruleListsManager.js';
import { isRuleInList } from '../rules/ruleListMembership.js';

function getDisplayName(list) {
  return list.id === GENERAL_RULE_LIST_ID ? t('rulelist_general') : list.name;
}

export function resolveRuleListContext(lists, selectedValue = GENERAL_RULE_LIST_ID) {
  return Array.isArray(lists) && lists.some(list => list?.id === selectedValue)
    ? selectedValue
    : GENERAL_RULE_LIST_ID;
}

export class RuleListsUI {
  static updateListGrid(container, lists, rules, handlers = {}) {
    container.innerHTML = '';
    const activeRuleListId = resolveRuleListContext(lists, handlers.activeRuleListId);

    for (const list of lists) {
      const card = document.createElement('div');
      const isActive = activeRuleListId === list.id;
      card.className = `rule-list-card ${isActive ? 'selected active-profile' : ''}`.trim();
      card.dataset.listId = list.id;

      const selector = document.createElement('input');
      selector.type = 'radio';
      selector.name = 'active-rule-list';
      selector.className = 'rule-list-profile-selector';
      selector.checked = isActive;
      selector.setAttribute('aria-label', getDisplayName(list));
      selector.addEventListener('change', () => {
        if (selector.checked) handlers.onSelect?.(list.id);
      });

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'rule-list-name rule-list-view';
      name.textContent = getDisplayName(list);
      if (isActive) name.setAttribute('aria-current', 'true');
      name.addEventListener('click', () => handlers.onSelect?.(list.id));

      const count = document.createElement('span');
      count.className = 'rule-list-count';
      count.textContent = rules.filter(rule => !rule.isWhitelist && isRuleInList(rule, list.id)).length;

      card.appendChild(selector);
      card.appendChild(name);
      card.appendChild(count);

      if (list.id !== GENERAL_RULE_LIST_ID) {
        const actions = document.createElement('span');
        actions.className = 'rule-list-actions';

        const renameButton = document.createElement('button');
        renameButton.type = 'button';
        renameButton.className = 'rule-list-action';
        renameButton.textContent = t('editbtn');
        renameButton.addEventListener('click', () => handlers.onRename?.(list));

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'rule-list-action danger';
        deleteButton.textContent = t('deletebtn');
        deleteButton.addEventListener('click', () => handlers.onDelete?.(list));

        actions.appendChild(renameButton);
        actions.appendChild(deleteButton);
        card.appendChild(actions);
      }

      container.appendChild(card);
    }
  }

  static getDisplayName(list) {
    return getDisplayName(list);
  }
}
