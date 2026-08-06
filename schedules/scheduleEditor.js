import { t } from '../scripts/t.js';
import { ScheduleFormatter } from '../utils/scheduleFormatter.js';
import {
  createDefaultSchedule,
  normalizeSchedule,
  SCHEDULE_VERSION
} from './scheduleNormalizer.js';
import { applySchedulePreset } from './schedulePresets.js';
import { validateSchedule } from './scheduleValidator.js';

function cloneSchedule(schedule) {
  const normalized = normalizeSchedule(schedule) || createDefaultSchedule();
  return {
    version: SCHEDULE_VERSION,
    periods: normalized.periods.map(period => ({
      days: [...period.days],
      startTime: period.startTime,
      endTime: period.endTime
    }))
  };
}

function createButton(text, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  if (className) button.className = className;
  return button;
}

export class ScheduleEditor {
  constructor({ logger = null } = {}) {
    this.logger = logger;
    this.formatter = new ScheduleFormatter();
    this.scheduleState = new WeakMap();
    this.activeDialogClose = null;
  }

  createSection(existingSchedule, enableSchedule, { dialogHost = null } = {}) {
    const section = document.createElement('div');
    section.className = `schedule-section ${enableSchedule ? 'pro-feature' : 'non-pro'}`;

    if (!enableSchedule) {
      section.textContent = t('profeatureschedule') || 'Schedule available in Pro';
      return section;
    }

    const normalizedExisting = normalizeSchedule(existingSchedule);
    this.scheduleState.set(section, normalizedExisting);

    const enableLabel = document.createElement('label');
    enableLabel.className = 'schedule-enable-label';

    const enableCheckbox = document.createElement('input');
    enableCheckbox.type = 'checkbox';
    enableCheckbox.className = 'enable-schedule-toggle';
    enableCheckbox.checked = !!normalizedExisting;
    enableLabel.appendChild(enableCheckbox);

    const enableText = document.createElement('span');
    enableText.textContent = t('enableschedule') || 'Enable schedule';
    enableLabel.appendChild(enableText);
    section.appendChild(enableLabel);

    const controls = document.createElement('div');
    controls.className = 'schedule-summary-controls';

    const summary = document.createElement('span');
    summary.className = 'schedule-summary';
    controls.appendChild(summary);

    const editButton = createButton(
      t('schedule_edit') || 'Edit schedule',
      'schedule-edit-button'
    );
    controls.appendChild(editButton);
    section.appendChild(controls);

    const updateSection = () => {
      const enabled = enableCheckbox.checked;
      controls.hidden = !enabled;

      if (enabled && !this.scheduleState.get(section)) {
        this.scheduleState.set(section, createDefaultSchedule());
      }

      const schedule = this.scheduleState.get(section);
      summary.textContent = enabled && schedule
        ? this.formatter.formatSchedule(schedule)
        : '';
    };

    enableCheckbox.addEventListener('change', updateSection);
    editButton.addEventListener('click', () => {
      const currentSchedule = this.scheduleState.get(section) || createDefaultSchedule();
      this.openDialog(currentSchedule, (updatedSchedule) => {
        this.scheduleState.set(section, updatedSchedule);
        enableCheckbox.checked = true;
        updateSection();
      }, { dialogHost });
    });

    updateSection();

    this.logger?.log('Created schedule section:', {
      enabled: enableCheckbox.checked,
      periods: normalizedExisting?.periods?.length || 0
    });

    return section;
  }

  getSchedule(section) {
    if (!section || section.nodeType === 3) {
      return null;
    }

    const enableCheckbox = section.querySelector('.enable-schedule-toggle');
    if (!enableCheckbox?.checked) {
      return null;
    }

    let schedule = this.scheduleState.get(section);
    if (!schedule) {
      schedule = createDefaultSchedule();
      this.scheduleState.set(section, schedule);
    }

    const validation = validateSchedule(schedule);

    if (!validation.isValid) {
      throw new Error(validation.errors[0] || 'invalidSchedule');
    }

    return cloneSchedule(schedule);
  }

  isDialogOpen() {
    return typeof this.activeDialogClose === 'function';
  }

  closeDialog() {
    this.activeDialogClose?.();
  }

  openDialog(initialSchedule, onSave, { dialogHost = null } = {}) {
    this.closeDialog();
    let draft = cloneSchedule(initialSchedule);

    const backdrop = document.createElement('div');
    backdrop.className = 'schedule-dialog-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'schedule-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', t('schedule_edit') || 'Edit schedule');
    backdrop.appendChild(dialog);

    const title = document.createElement('h3');
    title.textContent = t('schedule_edit') || 'Edit schedule';
    dialog.appendChild(title);

    const presetContainer = document.createElement('div');
    presetContainer.className = 'schedule-presets';
    dialog.appendChild(presetContainer);

    const periodsContainer = document.createElement('div');
    periodsContainer.className = 'schedule-periods';
    dialog.appendChild(periodsContainer);

    const errorElement = document.createElement('p');
    errorElement.className = 'schedule-dialog-error';
    errorElement.hidden = true;
    dialog.appendChild(errorElement);

    const footer = document.createElement('div');
    footer.className = 'schedule-dialog-actions';
    dialog.appendChild(footer);

    const addPeriodButton = createButton(
      t('schedule_add_period') || 'Add time group',
      'schedule-add-period'
    );
    footer.appendChild(addPeriodButton);

    const actionSpacer = document.createElement('span');
    actionSpacer.className = 'schedule-dialog-spacer';
    footer.appendChild(actionSpacer);

    const cancelButton = createButton(t('cancelbtn') || 'Cancel');
    footer.appendChild(cancelButton);

    const saveButton = createButton(t('savebtn') || 'Save', 'save-btn');
    footer.appendChild(saveButton);

    const validationMessage = (code) => {
      const messages = {
        invalid_days: t('invalidscheduledays') || 'Select at least one day for every time group.',
        invalid_time_format: t('invalidtimeformat') || 'Enter valid start and end times.',
        start_after_end: t('startafterend') || 'Start time must be before end time.',
        schedule_day_overlap: t('schedule_day_overlap') || 'Each day can be used only once.'
      };
      return messages[code] || t('invalidschedule') || 'Invalid schedule.';
    };

    const collectDraftFromDialog = () => ({
      version: SCHEDULE_VERSION,
      periods: Array.from(periodsContainer.querySelectorAll('.schedule-period-card')).map(card => ({
        days: Array.from(card.querySelectorAll('.schedule-period-days input:checked'))
          .map(input => Number(input.value)),
        startTime: card.querySelector('.schedule-period-start').value,
        endTime: card.querySelector('.schedule-period-end').value
      }))
    });

    const render = () => {
      periodsContainer.replaceChildren();

      draft.periods.forEach((period, periodIndex) => {
        const card = document.createElement('fieldset');
        card.className = 'schedule-period-card';

        const legend = document.createElement('legend');
        legend.textContent = `${t('schedule_period') || 'Time group'} ${periodIndex + 1}`;
        card.appendChild(legend);

        if (draft.periods.length > 1) {
          const removeButton = createButton(
            t('schedule_remove_period') || 'Remove',
            'schedule-remove-period'
          );
          removeButton.addEventListener('click', () => {
            draft = collectDraftFromDialog();
            draft.periods.splice(periodIndex, 1);
            render();
          });
          card.appendChild(removeButton);
        }

        const days = document.createElement('div');
        days.className = 'schedule-period-days';
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((day, dayIndex) => {
          const label = document.createElement('label');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = String(dayIndex);
          checkbox.checked = period.days.includes(dayIndex);
          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(t(`schedule_day_${day.toLowerCase()}`)));
          days.appendChild(label);
        });
        card.appendChild(days);

        const times = document.createElement('div');
        times.className = 'schedule-period-times';

        const startLabel = document.createElement('label');
        startLabel.appendChild(document.createTextNode(t('starttime') || 'Start:'));
        const startInput = document.createElement('input');
        startInput.type = 'time';
        startInput.className = 'schedule-period-start';
        startInput.value = period.startTime || '09:00';
        startLabel.appendChild(startInput);
        times.appendChild(startLabel);

        const endLabel = document.createElement('label');
        endLabel.appendChild(document.createTextNode(t('endtime') || 'End:'));
        const endInput = document.createElement('input');
        endInput.type = 'time';
        endInput.className = 'schedule-period-end';
        endInput.value = period.endTime || '17:00';
        endLabel.appendChild(endInput);
        times.appendChild(endLabel);

        card.appendChild(times);
        periodsContainer.appendChild(card);
      });

      addPeriodButton.disabled = draft.periods.length >= 7;
    };

    const addPresetButton = (labelKey, fallback, presetName) => {
      const button = createButton(t(labelKey) || fallback);
      button.addEventListener('click', () => {
        draft = applySchedulePreset(collectDraftFromDialog(), presetName);
        errorElement.hidden = true;
        render();
      });
      presetContainer.appendChild(button);
    };

    addPresetButton('schedule_every_day', 'Every day', 'everyDay');
    addPresetButton('schedule_weekdays', 'Weekdays', 'weekdays');
    addPresetButton('schedule_weekends', 'Weekends', 'weekends');

    addPeriodButton.addEventListener('click', () => {
      draft = collectDraftFromDialog();
      const usedDays = new Set(draft.periods.flatMap(period => period.days));
      const firstUnusedDay = [0, 1, 2, 3, 4, 5, 6]
        .find(day => !usedDays.has(day));

      draft.periods.push({
        days: firstUnusedDay === undefined ? [] : [firstUnusedDay],
        startTime: '09:00',
        endTime: '17:00'
      });
      render();
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
      if (this.activeDialogClose === close) {
        this.activeDialogClose = null;
      }
    };

    this.activeDialogClose = close;

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault?.();
      event.stopPropagation?.();
      close();
    };

    cancelButton.addEventListener('click', close);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    saveButton.addEventListener('click', () => {
      const candidate = collectDraftFromDialog();
      const validation = validateSchedule(candidate);

      if (!validation.isValid) {
        errorElement.textContent = validationMessage(validation.errors[0]);
        errorElement.hidden = false;
        return;
      }

      onSave(candidate);
      close();
    });

    document.addEventListener('keydown', onKeyDown);
    const mountTarget = dialogHost?.appendChild ? dialogHost : document.body;
    mountTarget.appendChild(backdrop);
    render();

    periodsContainer.querySelector('input')?.focus();
  }
}
