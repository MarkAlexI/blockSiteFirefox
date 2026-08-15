import { t } from '../scripts/t.js';
import { GENERAL_RULE_LIST_ID } from '../rules/ruleListsManager.js';

function getDisplayName(list) {
  return list.id === GENERAL_RULE_LIST_ID ? t('rulelist_general') : list.name;
}

export class RuleListsUI {
  static updateListGrid(container, lists, rules, handlers = {}) {
    container.innerHTML = '';

    for (const list of lists) {
      const card = document.createElement('div');
      card.className = `rule-list-card ${list.disabled ? 'muted' : ''}`;
      card.dataset.listId = list.id;

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'rule-list-toggle';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !list.disabled;
      checkbox.title = t('rulelists_toggle_hint');
      checkbox.addEventListener('change', () => handlers.onToggle?.(list.id));

      const name = document.createElement('span');
      name.className = 'rule-list-name';
      name.textContent = getDisplayName(list);

      const count = document.createElement('span');
      count.className = 'rule-list-count';
      count.textContent = rules.filter(rule => !rule.isWhitelist && (rule.listId || GENERAL_RULE_LIST_ID) === list.id).length;

      toggleLabel.appendChild(checkbox);
      toggleLabel.appendChild(name);
      toggleLabel.appendChild(count);
      card.appendChild(toggleLabel);

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
      } else {
        card.title = t('rulelists_description');
      }

      container.appendChild(card);
    }
  }

  static updateFilter(select, lists, selectedValue = 'all') {
    select.innerHTML = '';

    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = t('rulelists_all');
    select.appendChild(allOption);

    for (const list of lists) {
      const option = document.createElement('option');
      option.value = list.id;
      option.textContent = getDisplayName(list);
      select.appendChild(option);
    }

    select.value = lists.some(list => list.id === selectedValue) ? selectedValue : 'all';
  }

  static getDisplayName(list) {
    return getDisplayName(list);
  }
}
