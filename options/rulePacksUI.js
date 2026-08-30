import { t } from '../scripts/t.js';
import { getRulePacks } from '../rules/rulePacks.js';
import { recordTelemetryCounter } from '../telemetry/telemetryCounterReporter.js';

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
    scheduleContainer,
    scheduleEditor,
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
    this.scheduleContainer = scheduleContainer;
    this.scheduleEditor = scheduleEditor;
    this.scheduleSection = null;
    this.status = status;
    this.onAdd = onAdd;
    this.packs = getRulePacks();
  }

  initialize() {
    if (!this.dialog || !this.openButton || !this.packSelect) return;

    this.renderPackOptions();
    this.renderSelectedPack();
    this.resetScheduleSection();

    this.openButton.addEventListener('click', () => this.open());
    this.closeButton?.addEventListener('click', () => this.close());
    this.cancelButton?.addEventListener('click', () => this.close());
    this.packSelect.addEventListener('change', () => this.renderSelectedPack());
    this.selectAll?.addEventListener('change', () => this.toggleAllEntries());
    this.addButton?.addEventListener('click', () => this.addSelected());
    this.dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (this.scheduleEditor?.isDialogOpen?.()) {
        this.scheduleEditor.closeDialog();
        return;
      }
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

  resetScheduleSection() {
    if (!this.scheduleContainer || !this.scheduleEditor) return;

    this.scheduleEditor.closeDialog?.();
    this.scheduleSection = this.scheduleEditor.createSection(null, true, {
      dialogHost: this.dialog
    });
    this.scheduleSection.classList?.add('rule-packs-shared-schedule');
    this.scheduleContainer.replaceChildren(this.scheduleSection);
  }

  getSelectedSchedule() {
    if (!this.scheduleEditor || !this.scheduleSection) return null;
    return this.scheduleEditor.getSchedule(this.scheduleSection);
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
    this.resetScheduleSection();
    this.dialog.showModal();
    recordTelemetryCounter('rule_pack_dialog_opened');
  }

  close() {
    this.scheduleEditor?.closeDialog?.();
    if (this.dialog.open) this.dialog.close();
  }

  clearStatus() {
    if (!this.status) return;
    this.status.replaceChildren();
    this.status.textContent = '';
    this.status.classList.add('hidden');
    this.status.classList.remove('success', 'error');
  }

  showStatus(message, type) {
    if (!this.status) return;
    this.status.replaceChildren();
    this.status.textContent = message;
    this.status.classList.remove('hidden', 'success', 'error');
    this.status.classList.add(type);
  }

  createResultCount(labelKey, count, type) {
    const item = document.createElement('div');
    item.className = `rule-packs-result-count ${type}`;

    const label = document.createElement('span');
    label.textContent = t(labelKey);

    const value = document.createElement('strong');
    value.textContent = String(count);

    item.append(label, value);
    return item;
  }

  createResultGroup(labelKey, entries, type) {
    const section = document.createElement('section');
    section.className = `rule-packs-result-group ${type}`;

    const heading = document.createElement('h4');
    heading.textContent = t(labelKey);

    const list = document.createElement('ul');
    for (const entry of entries) {
      const item = document.createElement('li');
      item.textContent = entry.blockURL;
      list.appendChild(item);
    }

    section.append(heading, list);
    return section;
  }

  showResultReport(result = {}) {
    if (!this.status) return;

    const addedEntries = Array.isArray(result.addedEntries) ? result.addedEntries : [];
    const duplicateEntries = Array.isArray(result.duplicateEntries) ? result.duplicateEntries : [];
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    const addedCount = addedEntries.length || Number(result.addedCount || 0);
    const duplicateCount = duplicateEntries.length || Number(result.skippedDuplicates || 0);
    const conflictCount = conflicts.length;

    const summary = document.createElement('p');
    summary.className = 'rule-packs-result-summary';
    summary.textContent = addedCount === 0
      ? t('rulepacks_no_new_rules')
      : t('rulepacks_result', [addedCount, duplicateCount, conflictCount]);

    const counts = document.createElement('div');
    counts.className = 'rule-packs-result-counts';
    counts.append(
      this.createResultCount('rulepacks_added_label', addedCount, 'added'),
      this.createResultCount('rulepacks_duplicates_label', duplicateCount, 'duplicate'),
      this.createResultCount('rulepacks_conflicts_label', conflictCount, 'conflict')
    );

    const details = document.createElement('div');
    details.className = 'rule-packs-result-details';
    if (addedEntries.length > 0) {
      details.appendChild(
        this.createResultGroup('rulepacks_added_label', addedEntries, 'added')
      );
    }
    if (duplicateEntries.length > 0) {
      details.appendChild(
        this.createResultGroup('rulepacks_duplicates_label', duplicateEntries, 'duplicate')
      );
    }
    if (conflicts.length > 0) {
      details.appendChild(
        this.createResultGroup('rulepacks_conflicts_label', conflicts, 'conflict')
      );
    }

    this.status.replaceChildren(summary, counts);
    if (details.children.length > 0) {
      this.status.appendChild(details);
    }
    this.status.classList.remove('hidden', 'success', 'error');
    this.status.classList.add('success');
  }

  async addSelected() {
    const pack = this.getSelectedPack();
    const entryIds = this.getSelectedEntryIds();
    if (!pack || entryIds.length === 0 || typeof this.onAdd !== 'function') return;

    this.addButton.disabled = true;
    this.clearStatus();

    try {
      const schedule = this.getSelectedSchedule();
      const result = await this.onAdd(pack.id, entryIds, schedule);
      this.showResultReport(result);
    } catch (error) {
      this.showStatus(t('rulepacks_error'), 'error');
    } finally {
      this.updateSelectionState();
    }
  }
}
