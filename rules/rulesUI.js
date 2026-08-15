import { t } from '../scripts/t.js';
import Logger from '../utils/logger.js';
import { CATEGORIES } from './categoryManager.js';
import { ScheduleFormatter } from '../utils/scheduleFormatter.js';
import { ScheduleEditor } from '../schedules/scheduleEditor.js';
import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_SCHEDULE,
  BLOCKING_MODE_DAILY_LIMIT,
  getRuleBlockingMode,
  normalizeDailyLimit
} from './blockingMode.js';

export class RulesUI {
  constructor() {
    this.logger = new Logger('RulesUI');
    this.countdownTimers = new Map();
    this.scheduleFormatter = new ScheduleFormatter();
    this.scheduleEditor = new ScheduleEditor({ logger: this.logger });
  }

  isDeleteConfirmationInProgress(deleteButton) {
    const classList = deleteButton?.classList;
    return Boolean(
      classList?.contains('countdown-active') ||
      classList?.contains('delete-ready')
    );
  }

  handleRuleDeletion(deleteButton, onDelete, isStrictMode = false, buttonText = null) {
    if (isStrictMode) {
      this.startDeleteCountdown(deleteButton, onDelete, buttonText);
    } else {
      onDelete();
    }
  }

  startDeleteCountdown(deleteButton, onDelete, buttonText = null, countdownSeconds = 10, confirmSeconds = 5) {
    let countdown = countdownSeconds;
    const originalText = buttonText || deleteButton.textContent;
    const timerId = Date.now() + Math.random();

    deleteButton.disabled = true;
    deleteButton.classList.add('countdown-active');

    const updateButton = () => {
      deleteButton.textContent = `${originalText} (${countdown})`;
    };

    updateButton();

    const countdownInterval = setInterval(() => {
      countdown--;

      if (countdown > 0) {
        updateButton();
      } else {
        clearInterval(countdownInterval);
        this.countdownTimers.delete(timerId);

        deleteButton.disabled = false;
        deleteButton.classList.remove('countdown-active');
        deleteButton.classList.add('delete-ready');
        deleteButton.textContent = `${originalText} ✓`;

        const deleteHandler = () => {
          onDelete();
          deleteButton.removeEventListener('click', deleteHandler);
          deleteButton.removeEventListener('click', cancelHandler);
        };

        const cancelHandler = (e) => {
          if (e.detail === 2) {
            deleteButton.disabled = false;
            deleteButton.classList.remove('delete-ready');
            deleteButton.textContent = originalText;
            deleteButton.removeEventListener('click', deleteHandler);
            deleteButton.removeEventListener('click', cancelHandler);
          }
        };

        deleteButton.addEventListener('click', deleteHandler);
        deleteButton.addEventListener('click', cancelHandler);

        const resetTimeout = setTimeout(() => {
          if (deleteButton.parentNode) {
            deleteButton.disabled = false;
            deleteButton.classList.remove('delete-ready');
            deleteButton.textContent = originalText;
            deleteButton.removeEventListener('click', deleteHandler);
            deleteButton.removeEventListener('click', cancelHandler);
          }
        }, confirmSeconds * 1000);

        this.countdownTimers.set(`reset_${timerId}`, resetTimeout);
      }
    }, 1000);

    this.countdownTimers.set(timerId, countdownInterval);

    const cancelHandler = (e) => {
      if (e.detail === 2) {
        clearInterval(countdownInterval);
        this.countdownTimers.delete(timerId);
        deleteButton.disabled = false;
        deleteButton.classList.remove('countdown-active');
        deleteButton.textContent = originalText;
        deleteButton.removeEventListener('click', cancelHandler);
      }
    };

    deleteButton.addEventListener('click', cancelHandler);
  }

  createRuleDisplayRow(
    rule,
    index,
    onEdit,
    onDelete,
    onToggle,
    showEditButtons = true,
    disabledCategories = [],
    ruleLists = [],
    disabledRuleListIds = [],
    dailyUsageSeconds = {}
  ) {
    const row = document.createElement('tr');
    row.className = 'rule-row';
    row.dataset.ruleId = rule.id;

    if (rule.isWhitelist) {
      row.classList.add('rule-whitelist');
    }

    if (disabledCategories.includes(rule.category)) {
      row.classList.add('category-muted');
      row.title = t('category_disabled_desc') || 'This category is currently muted in settings';
    }

    const ruleListId = rule.listId || GENERAL_RULE_LIST_ID;
    if (!rule.isWhitelist && disabledRuleListIds.includes(ruleListId)) {
      row.classList.add('list-muted');
      if (!row.title) row.title = t('rulelists_disabled_desc');
    }

    const blockCell = document.createElement('td');
    blockCell.textContent = rule.blockURL;
    row.appendChild(blockCell);

    const redirectCell = document.createElement('td');
    redirectCell.textContent = rule.isWhitelist ? '—' : (rule.redirectURL || '—');
    if (rule.isWhitelist) {
      redirectCell.classList.add('text-disabled');
    }
    row.appendChild(redirectCell);

    const categoryCell = document.createElement('td');
    const categorySpan = document.createElement('span');
    categorySpan.className = `category-tag ${rule.category || 'uncategorized'}`;
    categorySpan.textContent = rule.isWhitelist ? (t('category_whitelist') || 'Whitelist') : (t(`category_${rule.category}`) || rule.category || t('category_uncategorized'));
    categoryCell.appendChild(categorySpan);
    row.appendChild(categoryCell);

    const listCell = document.createElement('td');
    if (rule.isWhitelist) {
      listCell.textContent = '-';
      listCell.classList.add('text-disabled');
    } else {
      const list = ruleLists.find(item => item.id === ruleListId);
      const listSpan = document.createElement('span');
      listSpan.className = `rule-list-tag ${ruleListId === GENERAL_RULE_LIST_ID ? 'general' : ''}`;
      listSpan.textContent = ruleListId === GENERAL_RULE_LIST_ID ? t('rulelist_general') : (list?.name || t('rulelist_general'));
      listCell.appendChild(listSpan);
    }
    row.appendChild(listCell);

    const blockingCell = document.createElement('td');
    const blockingMode = getRuleBlockingMode(rule);
    if (rule.isWhitelist) {
      blockingCell.textContent = t('status_allow');
      blockingCell.classList.add('status-static');
    } else if (blockingMode === BLOCKING_MODE_SCHEDULE && rule.schedule) {
      blockingCell.textContent = this.scheduleFormatter.formatSchedule(rule.schedule);
    } else if (blockingMode === BLOCKING_MODE_DAILY_LIMIT) {
      const limit = normalizeDailyLimit(rule.dailyLimit);
      const usedSeconds = Math.max(0, Number(dailyUsageSeconds[String(rule.id)]) || 0);
      const usedMinutes = Math.floor(usedSeconds / 60);
      const status = document.createElement('span');
      status.className = 'daily-limit-status';
      if (limit) {
        const shownUsed = Math.min(limit.minutes, usedMinutes);
        status.textContent = t('daily_limit_usage', [shownUsed, limit.minutes]) || `${shownUsed} / ${limit.minutes} min`;
        if (usedSeconds >= limit.minutes * 60) {
          status.classList.add('limit-reached');
          status.title = t('daily_limit_reached') || 'Daily limit reached';
        }
      } else {
        status.textContent = t('daily_limit_invalid') || 'Invalid daily limit';
      }
      blockingCell.appendChild(status);
    } else {
      const toggleElement = document.createElement('span');
      toggleElement.className = 'rule-toggle';
      toggleElement.textContent = rule.disabledByUser ? '✗' : '✓';
      toggleElement.title = rule.disabledByUser ? t('rule_disabled') || 'Disabled' : t('rule_enabled') || 'Enabled';
      toggleElement.style.cursor = 'pointer';
      toggleElement.addEventListener('click', async () => {
        try {
          await onToggle(rule.id);
        } catch (error) {
          this.logger.error('Toggle rule error:', error);
        }
      });
      blockingCell.appendChild(toggleElement);
    }
    row.appendChild(blockingCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';

    if (showEditButtons) {
      const editBtn = document.createElement('button');
      editBtn.textContent = t('editbtn');
      editBtn.addEventListener('click', () => onEdit(row, rule.id, rule));
      actionsCell.appendChild(editBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = t('deletebtn');
    deleteBtn.addEventListener('click', (e) => onDelete(e, rule.id));
    actionsCell.appendChild(deleteBtn);

    row.appendChild(actionsCell);
    return row;
  }

  createRuleEditRow(rule, index, onSave, onCancel, enableSchedule = false, currentDisabledByUser = false, ruleLists = []) {
    const row = document.createElement('tr');
    row.className = 'rule-row';
    const isWhitelist = rule.isWhitelist || false;
    if (isWhitelist) {
      row.classList.add('rule-whitelist');
    }

    const blockInput = document.createElement('input');
    blockInput.type = 'text';
    blockInput.value = rule.blockURL;
    blockInput.placeholder = t('blockurl');
    const blockCell = document.createElement('td');
    blockCell.className = 'edit-mode';
    blockCell.appendChild(blockInput);
    row.appendChild(blockCell);

    const redirectInput = document.createElement('input');
    redirectInput.type = 'text';
    redirectInput.value = isWhitelist ? '' : (rule.redirectURL || '');
    redirectInput.placeholder = isWhitelist ? 'N/A' : t('redirecturlplaceholder');
    redirectInput.disabled = isWhitelist;
    if (isWhitelist) {
      redirectInput.classList.add('input-disabled');
    } else {
      redirectInput.title = t('redirecturlhint');
      redirectInput.setAttribute(
        'aria-label',
        `${t('redirecturlheader')}. ${t('redirecturlhint')}`
      );
    }

    const redirectCell = document.createElement('td');
    redirectCell.className = 'edit-mode';
    redirectCell.appendChild(redirectInput);
    row.appendChild(redirectCell);

    const categoryCell = document.createElement('td');
    categoryCell.className = 'edit-mode';
    const categorySelect = document.createElement('select');
    categorySelect.className = 'category-select';

    if (isWhitelist) {
      const option = document.createElement('option');
      option.value = 'whitelist';
      option.textContent = t('category_whitelist') || 'Whitelist';
      categorySelect.appendChild(option);
      categorySelect.value = 'whitelist';
      categorySelect.disabled = true;
      categorySelect.classList.add('input-disabled');
    } else {
      CATEGORIES.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = t(`category_${cat}`) || cat;
        categorySelect.appendChild(option);
      });
      categorySelect.value = rule.category || 'social';
    }

    categoryCell.appendChild(categorySelect);
    row.appendChild(categoryCell);

    const listCell = document.createElement('td');
    listCell.className = 'edit-mode';
    const listSelect = document.createElement('select');
    listSelect.className = 'category-select rule-list-select';
    if (isWhitelist) {
      const option = document.createElement('option');
      option.value = GENERAL_RULE_LIST_ID;
      option.textContent = '-';
      listSelect.appendChild(option);
      listSelect.disabled = true;
      listSelect.classList.add('input-disabled');
    } else {
      for (const list of ruleLists) {
        const option = document.createElement('option');
        option.value = list.id;
        option.textContent = list.id === GENERAL_RULE_LIST_ID ? t('rulelist_general') : list.name;
        listSelect.appendChild(option);
      }
      listSelect.value = rule.listId || GENERAL_RULE_LIST_ID;
    }
    listCell.appendChild(listSelect);
    row.appendChild(listCell);

    const blockingCell = document.createElement('td');
    blockingCell.className = 'edit-mode';

    let blockingSection;
    if (isWhitelist) {
      blockingSection = document.createTextNode('-');
      blockingCell.appendChild(blockingSection);
    } else {
      blockingSection = this.createBlockingModeSection(rule, enableSchedule);
      blockingCell.appendChild(blockingSection);
    }
    row.appendChild(blockingCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = t('savebtn');
    saveBtn.addEventListener('click', () => {
      try {
        const category = isWhitelist ? 'whitelist' : categorySelect.value;
        const blockingConfig = isWhitelist ?
          { blockingMode: BLOCKING_MODE_ALWAYS, schedule: null, dailyLimit: null } :
          this.getBlockingConfigFromSection(blockingSection);
        const listId = isWhitelist ? GENERAL_RULE_LIST_ID : listSelect.value;
        onSave(
          rule.id,
          blockInput.value,
          isWhitelist ? '' : redirectInput.value,
          category,
          blockingConfig,
          listId
        );
      } catch (error) {
        this.logger.info('Edit: Schedule error:', error.message);
        this.showErrorMessage(this.getValidationMessage(error.message));
      }
    });
    actionsCell.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('cancelbtn');
    cancelBtn.addEventListener('click', onCancel);
    actionsCell.appendChild(cancelBtn);

    row.appendChild(actionsCell);
    return row;
  }

  createAddRuleRow(onSave, onCancel, enableSchedule = false, isWhitelist = false, ruleLists = []) {
    const row = document.createElement('tr');
    row.className = 'rule-row';
    if (isWhitelist) {
      row.classList.add('rule-whitelist');
    }

    const blockInput = document.createElement('input');
    blockInput.type = 'text';
    blockInput.placeholder = t('blockurl');

    setTimeout(() => {
      blockInput.focus();
    }, 100);

    const blockCell = document.createElement('td');
    blockCell.className = 'edit-mode';
    blockCell.appendChild(blockInput);

    if (!isWhitelist) {
      const mobileHint = document.createElement('small');
      mobileHint.className = 'mobile-link-hint';
      mobileHint.textContent = t('mobilecopylinkhint');
      blockCell.appendChild(mobileHint);
    }

    row.appendChild(blockCell);

    const redirectInput = document.createElement('input');
    redirectInput.type = 'text';
    redirectInput.placeholder = isWhitelist ? 'N/A' : t('redirecturlplaceholder');
    redirectInput.disabled = isWhitelist;
    if (isWhitelist) {
      redirectInput.classList.add('input-disabled');
    } else {
      redirectInput.title = t('redirecturlhint');
      redirectInput.setAttribute(
        'aria-label',
        `${t('redirecturlheader')}. ${t('redirecturlhint')}`
      );
    }

    const redirectCell = document.createElement('td');
    redirectCell.className = 'edit-mode';
    redirectCell.appendChild(redirectInput);
    row.appendChild(redirectCell);

    const categoryCell = document.createElement('td');
    categoryCell.className = 'edit-mode';
    const categorySelect = document.createElement('select');
    categorySelect.className = 'category-select';

    if (isWhitelist) {
      const option = document.createElement('option');
      option.value = 'whitelist';
      option.textContent = t('category_whitelist') || 'Whitelist';
      categorySelect.appendChild(option);
      categorySelect.value = 'whitelist';
      categorySelect.disabled = true;
      categorySelect.classList.add('input-disabled');
    } else {
      CATEGORIES.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = t(`category_${cat}`) || cat;
        categorySelect.appendChild(option);
      });
      categorySelect.value = 'social';
    }

    categoryCell.appendChild(categorySelect);
    row.appendChild(categoryCell);

    const listCell = document.createElement('td');
    listCell.className = 'edit-mode';
    const listSelect = document.createElement('select');
    listSelect.className = 'category-select rule-list-select';
    if (isWhitelist) {
      const option = document.createElement('option');
      option.value = GENERAL_RULE_LIST_ID;
      option.textContent = '-';
      listSelect.appendChild(option);
      listSelect.disabled = true;
      listSelect.classList.add('input-disabled');
    } else {
      for (const list of ruleLists) {
        const option = document.createElement('option');
        option.value = list.id;
        option.textContent = list.id === GENERAL_RULE_LIST_ID ? t('rulelist_general') : list.name;
        listSelect.appendChild(option);
      }
      listSelect.value = GENERAL_RULE_LIST_ID;
    }
    listCell.appendChild(listSelect);
    row.appendChild(listCell);

    const blockingCell = document.createElement('td');
    blockingCell.className = 'edit-mode';

    let blockingSection;
    if (isWhitelist) {
      blockingSection = document.createTextNode('-');
      blockingCell.appendChild(blockingSection);
    } else {
      blockingSection = this.createBlockingModeSection({
        blockingMode: BLOCKING_MODE_ALWAYS,
        schedule: null,
        dailyLimit: null
      }, enableSchedule);
      blockingCell.appendChild(blockingSection);
    }
    row.appendChild(blockingCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = t('savebtn');
    saveBtn.addEventListener('click', () => {
      try {
        const category = isWhitelist ? 'whitelist' : categorySelect.value;
        const blockingConfig = isWhitelist ?
          { blockingMode: BLOCKING_MODE_ALWAYS, schedule: null, dailyLimit: null } :
          this.getBlockingConfigFromSection(blockingSection);
        const listId = isWhitelist ? GENERAL_RULE_LIST_ID : listSelect.value;
        onSave(
          blockInput.value,
          isWhitelist ? '' : redirectInput.value,
          category,
          blockingConfig,
          listId,
          row
        );
      } catch (error) {
        this.logger.info('Add: Schedule error:', error.message);
        this.showErrorMessage(this.getValidationMessage(error.message));
      }
    });
    actionsCell.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('cancelbtn');
    cancelBtn.addEventListener('click', () => onCancel(row));
    actionsCell.appendChild(cancelBtn);

    row.appendChild(actionsCell);
    return row;
  }

  createEmptyRow(message, colSpan = 6) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = colSpan;
    cell.textContent = message;
    row.appendChild(cell);
    return row;
  }

  updateStatus(statusElement, count) {
    if (statusElement) {
      const message = t('savedrules', count.toString());
      if (statusElement.tagName.toLowerCase() === 'input') {
        statusElement.value = message;
      } else {
        statusElement.textContent = message;
      }
    }
  }

  showAlert(message) {
    if (typeof customAlert !== 'undefined') {
      customAlert(message);
    } else {
      alert(message);
    }
  }

  createBlockingModeSection(rule, enableAdvancedModes) {
    const section = document.createElement('div');
    section.className = 'blocking-mode-section';
    const currentMode = getRuleBlockingMode(rule);

    const modeSelect = document.createElement('select');
    modeSelect.className = 'category-select blocking-mode-select';
    const modeOptions = [
      [BLOCKING_MODE_ALWAYS, t('blocking_mode_always') || 'Always'],
      [BLOCKING_MODE_SCHEDULE, t('blocking_mode_schedule') || 'Schedule'],
      [BLOCKING_MODE_DAILY_LIMIT, t('blocking_mode_daily_limit') || 'Daily limit']
    ];

    for (const [value, label] of modeOptions) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      if (!enableAdvancedModes && value !== BLOCKING_MODE_ALWAYS && value !== currentMode) {
        option.disabled = true;
      }
      modeSelect.appendChild(option);
    }
    modeSelect.value = currentMode;
    if (!enableAdvancedModes && currentMode !== BLOCKING_MODE_ALWAYS) {
      modeSelect.disabled = true;
    }
    section.appendChild(modeSelect);

    const scheduleWrap = document.createElement('div');
    scheduleWrap.className = 'blocking-mode-detail blocking-mode-schedule';
    const scheduleSection = this.createScheduleSection(
      currentMode === BLOCKING_MODE_SCHEDULE ? rule.schedule : null,
      true
    );
    const scheduleEnableLabel = scheduleSection.querySelector('.schedule-enable-label');
    if (scheduleEnableLabel) scheduleEnableLabel.hidden = true;
    const scheduleToggle = scheduleSection.querySelector('.enable-schedule-toggle');
    if (scheduleToggle) {
      scheduleToggle.checked = true;
      scheduleToggle.dispatchEvent(new Event('change'));
      if (!enableAdvancedModes && currentMode === BLOCKING_MODE_SCHEDULE) scheduleToggle.disabled = true;
    }
    const scheduleEditButton = scheduleSection.querySelector('.schedule-edit-button');
    if (scheduleEditButton && !enableAdvancedModes && currentMode === BLOCKING_MODE_SCHEDULE) {
      scheduleEditButton.disabled = true;
    }
    scheduleWrap.appendChild(scheduleSection);
    section.appendChild(scheduleWrap);

    const dailyWrap = document.createElement('label');
    dailyWrap.className = 'blocking-mode-detail daily-limit-editor';
    const dailyLabel = document.createElement('span');
    dailyLabel.textContent = t('daily_limit_minutes_label') || 'Minutes per day';
    dailyWrap.appendChild(dailyLabel);
    const dailyInput = document.createElement('input');
    dailyInput.type = 'number';
    dailyInput.className = 'daily-limit-minutes';
    dailyInput.min = '1';
    dailyInput.max = '1440';
    dailyInput.step = '1';
    dailyInput.value = String(normalizeDailyLimit(rule.dailyLimit)?.minutes || 30);
    if (!enableAdvancedModes && currentMode === BLOCKING_MODE_DAILY_LIMIT) dailyInput.disabled = true;
    dailyWrap.appendChild(dailyInput);
    const dailyHint = document.createElement('small');
    dailyHint.textContent = t('daily_limit_hint') || 'The site is allowed until this daily budget is used.';
    dailyWrap.appendChild(dailyHint);
    section.appendChild(dailyWrap);

    const updateVisibility = () => {
      const mode = modeSelect.value;
      scheduleWrap.hidden = mode !== BLOCKING_MODE_SCHEDULE;
      dailyWrap.hidden = mode !== BLOCKING_MODE_DAILY_LIMIT;
      if (mode === BLOCKING_MODE_SCHEDULE && scheduleToggle && !scheduleToggle.checked) {
        scheduleToggle.checked = true;
        scheduleToggle.dispatchEvent(new Event('change'));
      }
    };
    modeSelect.addEventListener('change', updateVisibility);
    updateVisibility();

    section._blockingModeControls = { modeSelect, scheduleSection, dailyInput };
    return section;
  }

  getBlockingConfigFromSection(section) {
    const controls = section?._blockingModeControls;
    if (!controls) {
      return { blockingMode: BLOCKING_MODE_ALWAYS, schedule: null, dailyLimit: null };
    }

    const blockingMode = controls.modeSelect.value;
    if (blockingMode === BLOCKING_MODE_SCHEDULE) {
      return {
        blockingMode,
        schedule: this.getScheduleFromSection(controls.scheduleSection),
        dailyLimit: null
      };
    }

    if (blockingMode === BLOCKING_MODE_DAILY_LIMIT) {
      const minutes = Math.floor(Number(controls.dailyInput.value));
      const dailyLimit = normalizeDailyLimit({ minutes });
      if (!dailyLimit) throw new Error('daily_limit_invalid');
      return { blockingMode, schedule: null, dailyLimit };
    }

    return { blockingMode: BLOCKING_MODE_ALWAYS, schedule: null, dailyLimit: null };
  }

  createScheduleSection(existingSchedule, enableSchedule) {
    return this.scheduleEditor.createSection(existingSchedule, enableSchedule);
  }

  getScheduleFromSection(section) {
    return this.scheduleEditor.getSchedule(section);
  }

  getValidationMessage(errorType) {
    const invalidRedirectMessage = [
      t('wrongredirecturl'),
      t('redirecturlhint')
    ].filter(Boolean).join(' - ');

    const messages = {
      'blockurl_empty': t('blockurl'),
      'blockurl_restrict': t('restrictedblockurl'),
      'blockurl_invalid': t('wrongblockurl'),
      'redirect_invalid': invalidRedirectMessage,
      'invalid_days': t('invaliddays') || 'Invalid days selected',
      'invalid_time_format': t('invalidtimeformat') || 'Invalid time format (HH:MM)',
      'start_after_end': t('startafterend') || 'Start time must be before end time',
      'schedule_day_overlap': t('schedule_day_overlap') || 'Each day can be used only once',
      'category_required': t('category_required') || 'Category is required',
      'invalidSchedule: no days selected': t('invalidscheduledays') || 'Invalid schedule: please select at least one day',
      'invalidSchedule: start time is empty': t('invalidschedulestarttime') || 'Invalid schedule: please set a start time',
      'invalidSchedule: end time is empty': t('invalidscheduleendtime') || 'Invalid schedule: please set an end time',
      'invalidSchedule': t('invalidschedule') || 'Invalid schedule: please select days and times',
      'daily_limit_invalid': t('daily_limit_invalid') || 'Enter a daily limit between 1 and 1440 minutes',
      'schedule_required': t('schedule_required') || 'Create a schedule for Schedule mode',
      'blocking_mode_conflict': t('blocking_mode_conflict') || 'Schedule and Daily limit cannot be used together',
      'blocking_mode_invalid': t('blocking_mode_invalid') || 'Select a valid blocking mode',
      'conflict_whitelist': t('conflict_whitelist_err') || 'This site is already in your Whitelist. Remove it first.',
      'conflict_blacklist': t('conflict_blacklist_err') || 'This site is already in your Blacklist. Remove it first.',
      'redundant_whitelist': t('redundant_whitelist_err')
    };

    return messages[errorType] || errorType;
  }

  showValidationErrors(errors) {
    const messages = errors.map(error => this.getValidationMessage(error));
    this.showAlert(messages.join('\n'));
  }

  showSuccessMessage(message, statusElement = null) {
    if (statusElement) {
      if (statusElement.tagName.toLowerCase() === 'input') {
        statusElement.value = message;
      } else {
        statusElement.textContent = message;
      }
    }
  }

  showErrorMessage(message) {
    this.showAlert(message);
  }

  clearCountdownTimer(button) {
    for (const [timerId, timer] of this.countdownTimers.entries()) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.countdownTimers.clear();

    button.disabled = false;
    button.classList.remove('countdown-active', 'delete-ready');
  }

  cleanup() {
    for (const [timerId, timer] of this.countdownTimers.entries()) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.countdownTimers.clear();
  }
}
