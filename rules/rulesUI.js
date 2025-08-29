import { t } from '../scripts/t.js';

export class RulesUI {
  constructor() {
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

  createRuleDisplayRow(rule, index, onEdit, onDelete) {
    const row = document.createElement('tr');
    row.className = 'rule-row';
    row.dataset.ruleId = rule.id;

    const blockCell = document.createElement('td');
    blockCell.textContent = rule.blockURL;
    row.appendChild(blockCell);

    const redirectCell = document.createElement('td');
    redirectCell.textContent = rule.redirectURL || '—';
    row.appendChild(redirectCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';

    const editBtn = document.createElement('button');
    editBtn.textContent = t('editbtn');
    editBtn.addEventListener('click', () => onEdit(row, index, rule));
    actionsCell.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = t('deletebtn');
    deleteBtn.addEventListener('click', (e) => onDelete(e, index));
    actionsCell.appendChild(deleteBtn);
    
    row.appendChild(actionsCell);
    return row;
  }
  
  createRuleEditRow(rule, index, onSave, onCancel) {
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

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = t('savebtn');
    saveBtn.addEventListener('click', () => onSave(index, blockInput.value, redirectInput.value, rule.id));
    actionsCell.appendChild(saveBtn);
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('cancelbtn');
    cancelBtn.addEventListener('click', onCancel);
    actionsCell.appendChild(cancelBtn);
    
    row.appendChild(actionsCell);
    return row;
  }
  
  createAddRuleRow(onSave, onCancel) {
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

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = t('savebtn');
    saveBtn.addEventListener('click', () => onSave(blockInput.value, redirectInput.value, row));
    actionsCell.appendChild(saveBtn);
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('cancelbtn');
    cancelBtn.addEventListener('click', () => onCancel(row));
    actionsCell.appendChild(cancelBtn);
    
    row.appendChild(actionsCell);
    return row;
  }
  
  createEmptyRow(message, colSpan = 3) {
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
  
  getValidationMessage(errorType) {
    const messages = {
      'blockurl_empty': t('blockurl'),
      'blockurl_ascii': t('blockurlonlyascii'),
      'blockurl_lowercase': t('blockurlonlylower'),
      'redirect_invalid': t('wrongredirecturl')
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