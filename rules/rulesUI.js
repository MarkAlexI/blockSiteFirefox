import { t } from '../scripts/t.js';
import Logger from '../utils/logger.js';

export class RulesUI {
  constructor() {
    this.logger = new Logger('RulesUI');
    this.countdownTimers = new Map();
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
  
  createRuleDisplayRow(rule, index, onEdit, onDelete, showEditButtons = true) {
    const row = document.createElement('tr');
    row.className = 'rule-row';
    row.dataset.ruleId = rule.id;
    
    const blockCell = document.createElement('td');
    blockCell.textContent = rule.blockURL;
    row.appendChild(blockCell);
    
    const redirectCell = document.createElement('td');
    redirectCell.textContent = rule.redirectURL || '—';
    row.appendChild(redirectCell);
    
    const categoryCell = document.createElement('td');
    const categorySpan = document.createElement('span');
    categorySpan.className = `category-tag ${rule.category || 'uncategorized'}`;
    categorySpan.textContent = t(`category_${rule.category}`) || rule.category || t('category_uncategorized');
    categoryCell.appendChild(categorySpan);
    row.appendChild(categoryCell);
    
    const scheduleCell = document.createElement('td');
    if (rule.schedule) {
      const daysStr = rule.schedule.days.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ');
      scheduleCell.textContent = `${daysStr}, ${rule.schedule.startTime}-${rule.schedule.endTime}`;
    } else {
      scheduleCell.textContent = t('alwaysactive');
    }
    row.appendChild(scheduleCell);
    
    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';
    
    if (showEditButtons) {
      const editBtn = document.createElement('button');
      editBtn.textContent = t('editbtn');
      editBtn.addEventListener('click', () => onEdit(row, index, rule));
      actionsCell.appendChild(editBtn);
    }
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = t('deletebtn');
    deleteBtn.addEventListener('click', (e) => onDelete(e, index));
    actionsCell.appendChild(deleteBtn);
    
    row.appendChild(actionsCell);
    return row;
  }
  
  createRuleEditRow(rule, index, onSave, onCancel, enableSchedule = false) {
    const row = document.createElement('tr');
    row.className = 'rule-row';
    
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
    redirectInput.value = rule.redirectURL || '';
    redirectInput.placeholder = t('redirecturl');
    const redirectCell = document.createElement('td');
    redirectCell.className = 'edit-mode';
    redirectCell.appendChild(redirectInput);
    row.appendChild(redirectCell);
    
    const categoryCell = document.createElement('td');
    categoryCell.className = 'edit-mode';
    const categorySelect = document.createElement('select');
    categorySelect.className = 'category-select';
    const categories = ['social', 'news', 'entertainment', 'shopping', 'work', 'gaming', 'adult', 'uncategorized'];
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat;
      option.textContent = t(`category_${cat}`) || cat;
      categorySelect.appendChild(option);
    });
    categorySelect.value = rule.category || 'social';
    categoryCell.appendChild(categorySelect);
    row.appendChild(categoryCell);
    
    const scheduleCell = document.createElement('td');
    scheduleCell.className = 'edit-mode';
    
    const scheduleSection = this.createScheduleSection(rule.schedule, enableSchedule);
    scheduleCell.appendChild(scheduleSection);
    row.appendChild(scheduleCell);
    
    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = t('savebtn');
    saveBtn.addEventListener('click', () => {
      try {
        const category = categorySelect.value;
        const schedule = this.getScheduleFromSection(scheduleSection);
        onSave(index, blockInput.value, redirectInput.value, category, schedule, rule.id);
      } catch (error) {
        this.logger.info('Edit: Schedule error:', error.message);
        this.showErrorMessage(t('invalidschedule') || 'Invalid schedule: please select days and times');
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
  
  createAddRuleRow(onSave, onCancel, enableSchedule = false) {
    const row = document.createElement('tr');
    row.className = 'rule-row';
    
    const blockInput = document.createElement('input');
    blockInput.type = 'text';
    blockInput.placeholder = t('blockurl');
    const blockCell = document.createElement('td');
    blockCell.className = 'edit-mode';
    blockCell.appendChild(blockInput);
    row.appendChild(blockCell);
    
    const redirectInput = document.createElement('input');
    redirectInput.type = 'text';
    redirectInput.placeholder = t('redirecturl');
    const redirectCell = document.createElement('td');
    redirectCell.className = 'edit-mode';
    redirectCell.appendChild(redirectInput);
    row.appendChild(redirectCell);
    
    const categoryCell = document.createElement('td');
    categoryCell.className = 'edit-mode';
    const categorySelect = document.createElement('select');
    categorySelect.className = 'category-select';
    const categories = ['social', 'news', 'entertainment', 'shopping', 'work', 'gaming', 'adult', 'uncategorized'];
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat;
      option.textContent = t(`category_${cat}`) || cat;
      categorySelect.appendChild(option);
    });
    categorySelect.value = 'social';
    categoryCell.appendChild(categorySelect);
    row.appendChild(categoryCell);
    
    const scheduleCell = document.createElement('td');
    scheduleCell.className = 'edit-mode';
    
    const scheduleSection = this.createScheduleSection(null, enableSchedule);
    scheduleCell.appendChild(scheduleSection);
    row.appendChild(scheduleCell);
    
    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = t('savebtn');
    saveBtn.addEventListener('click', () => {
      try {
        const category = categorySelect.value;
        const schedule = this.getScheduleFromSection(scheduleSection);
        onSave(blockInput.value, redirectInput.value, category, schedule, row);
      } catch (error) {
        this.logger.info('Add: Schedule error:', error.message);
        this.showErrorMessage(t('invalidschedule') || 'Invalid schedule: please select days and times');
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
  
  createEmptyRow(message, colSpan = 5) {
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
  
  createScheduleSection(existingSchedule, enableSchedule) {
    const section = document.createElement('div');
    section.className = `schedule-section ${enableSchedule ? 'pro-feature' : 'non-pro'}`;
    
    if (!enableSchedule) {
      section.textContent = t('profeatureschedule') || 'Schedule available in Pro';
      return section;
    }
    
    const enableCheckbox = document.createElement('input');
    enableCheckbox.type = 'checkbox';
    enableCheckbox.id = 'enable-schedule';
    enableCheckbox.checked = !!existingSchedule;
    section.appendChild(enableCheckbox);
    section.appendChild(document.createTextNode(t('enableschedule') || 'Enable schedule'));
    
    const daysContainer = document.createElement('div');
    daysContainer.className = 'days-container';
    daysContainer.style.display = enableCheckbox.checked ? 'flex' : 'none';
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((day, i) => {
      const label = document.createElement('label');
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.value = i;
      if (existingSchedule?.days?.includes(i)) chk.checked = true;
      label.appendChild(chk);
      label.appendChild(document.createTextNode(t(`schedule_day_${day.toLowerCase()}`)));
      daysContainer.appendChild(label);
    });
    section.appendChild(daysContainer);
    
    const timeContainer = document.createElement('div');
    timeContainer.className = 'time-container';
    timeContainer.style.display = enableCheckbox.checked ? 'flex' : 'none';
    
    const startLabel = document.createElement('label');
    startLabel.textContent = t('starttime') || 'Start:';
    const startTime = document.createElement('input');
    startTime.type = 'time';
    startTime.className = 'start-time';
    startTime.required = true;
    startTime.value = existingSchedule?.startTime || '09:00';
    startLabel.appendChild(startTime);
    timeContainer.appendChild(startLabel);
    
    const endLabel = document.createElement('label');
    endLabel.textContent = t('endtime') || 'End:';
    const endTime = document.createElement('input');
    endTime.type = 'time';
    endTime.className = 'end-time';
    endTime.required = true;
    endTime.value = existingSchedule?.endTime || '17:00';
    endLabel.appendChild(endTime);
    timeContainer.appendChild(endLabel);
    
    section.appendChild(timeContainer);
    
    enableCheckbox.addEventListener('change', () => {
      daysContainer.style.display = enableCheckbox.checked ? 'flex' : 'none';
      timeContainer.style.display = enableCheckbox.checked ? 'flex' : 'none';
    });
    
    this.logger.log('Created schedule section:', {
      enableChecked: enableCheckbox.checked,
      days: existingSchedule?.days,
      startTime: startTime.value,
      endTime: endTime.value
    });
    
    return section;
  }
  
  getScheduleFromSection(section) {
    const enableCheckbox = section.querySelector('#enable-schedule');
    if (!enableCheckbox?.checked) {
      return null;
    }
    
    const days = Array.from(section.querySelectorAll('.days-container input[type="checkbox"]:checked'))
      .map(chk => parseInt(chk.value));
    
    const startTimeInput = section.querySelector('.time-container input.start-time');
    const endTimeInput = section.querySelector('.time-container input.end-time');
    
    const startTime = startTimeInput?.value;
    const endTime = endTimeInput?.value;
    
    if (days.length === 0) {
      throw new Error('invalidSchedule: no days selected');
    }
    if (!startTime) {
      throw new Error('invalidSchedule: start time is empty');
    }
    if (!endTime) {
      throw new Error('invalidSchedule: end time is empty');
    }
    
    return { days, startTime, endTime };
  }
  
  getValidationMessage(errorType) {
    const messages = {
      'blockurl_empty': t('blockurl'),
      'blockurl_ascii': t('blockurlonlyascii'),
      'blockurl_lowercase': t('blockurlonlylower'),
      'redirect_invalid': t('wrongredirecturl'),
      'invalid_days': t('invaliddays') || 'Invalid days selected',
      'invalid_time_format': t('invalidtimeformat') || 'Invalid time format (HH:MM)',
      'start_after_end': t('startafterend') || 'Start time must be before end time',
      'category_required': t('category_required') || 'Category is required',
      'invalidSchedule: no days selected': t('invalidscheduledays') || 'Invalid schedule: please select at least one day',
      'invalidSchedule: start time is empty': t('invalidschedulestarttime') || 'Invalid schedule: please set a start time',
      'invalidSchedule: end time is empty': t('invalidscheduleendtime') || 'Invalid schedule: please set an end time',
      'invalidSchedule': t('invalidschedule') || 'Invalid schedule: please select days and times'
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