import { t } from '../scripts/t.js';
import { getRulePacks } from '../rules/rulePacks.js';

export class RulePacksUI {
  constructor({
    dialog,
    openButton,
    closeButton,
    cancelButton,
    addButton,
    packSelect,
    description,
    category,
    selectAll,
    entriesContainer,
    status,
    onAdd
  }) {
    this.dialog = dialog;
    this.openButton = openButton;
    this.closeButton = closeButton;
    this.cancelButton = cancelButton;
    this.addButton = addButton;
    this.packSelect = packSelect;
    this.description = description;
    this.category = category;
    this.selectAll = selectAll;
    this.entriesContainer = entriesContainer;
    this.status = status;
    this.onAdd = onAdd;
    this.packs = getRulePacks();
  }

  initialize() {
    if (!this.dialog || !this.openButton || !this.packSelect) return;

    this.renderPackOptions();
    this.renderSelectedPack();

    this.openButton.addEventListener('click', () => this.open());
    this.closeButton?.addEventListener('click', () => this.close());
    this.cancelButton?.addEventListener('click', () => this.close());
    this.packSelect.addEventListener('change', () => this.renderSelectedPack());
    this.selectAll?.addEventListener('change', () => this.toggleAllEntries());
    this.addButton?.addEventListener('click', () => this.addSelected());
    this.dialog.addEventListener('cancel', event => {
      event.preventDefault();
      this.close();
    });
  }

  renderPackOptions() {
    this.packSelect.replaceChildren();

    for (const pack of this.packs) {
      const option = document.createElement('option');
      option.value = pack.id;
      option.textContent = t(pack.titleKey);
      this.packSelect.appendChild(option);
    }
  }

  getSelectedPack() {
    return this.packs.find(pack => pack.id === this.packSelect.value) || this.packs[0] || null;
  }

  renderSelectedPack() {
    const pack = this.getSelectedPack();
    if (!pack) return;

    this.description.textContent = t(pack.descriptionKey);
    this.category.textContent = t(`category_${pack.category}`);
    this.entriesContainer.replaceChildren();

    for (const entry of pack.entries) {
      const label = document.createElement('label');
      label.className = 'rule-pack-entry';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = entry.id;
      checkbox.checked = true;
      checkbox.addEventListener('change', () => this.updateSelectionState());

      const value = document.createElement('span');
      value.textContent = entry.blockURL;

      label.append(checkbox, value);
      this.entriesContainer.appendChild(label);
    }

    if (this.selectAll) {
      this.selectAll.checked = true;
      this.selectAll.indeterminate = false;
    }

    this.clearStatus();
    this.updateSelectionState();
  }

  getEntryCheckboxes() {
    return [...this.entriesContainer.querySelectorAll('input[type="checkbox"]')];
  }

  getSelectedEntryIds() {
    return this.getEntryCheckboxes()
      .filter(checkbox => checkbox.checked)
      .map(checkbox => checkbox.value);
  }

  updateSelectionState() {
    const checkboxes = this.getEntryCheckboxes();
    const selectedCount = checkboxes.filter(checkbox => checkbox.checked).length;

    if (this.selectAll) {
      this.selectAll.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
      this.selectAll.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
    }

    if (this.addButton) {
      this.addButton.disabled = selectedCount === 0;
    }
  }

  toggleAllEntries() {
    const checked = this.selectAll?.checked === true;
    for (const checkbox of this.getEntryCheckboxes()) {
      checkbox.checked = checked;
    }
    this.updateSelectionState();
  }

  open() {
    this.renderSelectedPack();
    this.dialog.showModal();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  clearStatus() {
    if (!this.status) return;
    this.status.textContent = '';
    this.status.classList.add('hidden');
    this.status.classList.remove('success', 'error');
  }

  showStatus(message, type) {
    if (!this.status) return;
    this.status.textContent = message;
    this.status.classList.remove('hidden', 'success', 'error');
    this.status.classList.add(type);
  }

  async addSelected() {
    const pack = this.getSelectedPack();
    const entryIds = this.getSelectedEntryIds();
    if (!pack || entryIds.length === 0 || typeof this.onAdd !== 'function') return;

    this.addButton.disabled = true;
    this.clearStatus();

    try {
      const result = await this.onAdd(pack.id, entryIds);
      const addedCount = Number(result?.addedCount || 0);
      const skippedDuplicates = Number(result?.skippedDuplicates || 0);
      const conflictCount = Array.isArray(result?.conflicts) ? result.conflicts.length : 0;

      if (addedCount === 0) {
        this.showStatus(t('rulepacks_no_new_rules'), 'success');
      } else {
        this.showStatus(
          t('rulepacks_result', [addedCount, skippedDuplicates, conflictCount]),
          'success'
        );
      }
    } catch (error) {
      this.showStatus(t('rulepacks_error'), 'error');
    } finally {
      this.updateSelectionState();
    }
  }
}
