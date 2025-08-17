import { isValidURL } from '../scripts/isValidURL.js';
import { isValidAscii } from '../scripts/isValidAscii.js';
import { isOnlyLowerCase } from '../scripts/isOnlyLowerCase.js';

const rulesBody = document.getElementById('rules-body');
const addRuleButton = document.getElementById('add-rule');
const statusElement = document.getElementById('status');

document.getElementById('options-title').textContent = browser.i18n.getMessage('header');
document.getElementById('header-text').textContent = browser.i18n.getMessage('header');
addRuleButton.textContent = browser.i18n.getMessage('addrule');
document.getElementById('block-url-header').textContent = browser.i18n.getMessage('blockurl');
document.getElementById('redirect-url-header').textContent = browser.i18n.getMessage('redirecturl');
document.getElementById('actions-header').textContent = browser.i18n.getMessage('actionsheader') || 'Дії';

const wrongRedirectUrl = browser.i18n.getMessage('wrongredirecturl');
const blockUrlOnlyAscii = browser.i18n.getMessage('blockurlonlyascii');
const blockUrlOnlyLower = browser.i18n.getMessage('blockurlonlylower');
const alertRuleExist = browser.i18n.getMessage('alertruleexist');

function loadRules() {
  browser.storage.sync.get('rules', ({ rules }) => {
    rules = rules || [];
    rulesBody.innerHTML = '';
    
    rules.forEach((rule, index) => {
      const row = createRuleRow(rule, index);
      rulesBody.appendChild(row);
    });
    
    if (rules.length === 0) {
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = 3;
      emptyCell.textContent = browser.i18n.getMessage('norules');
      emptyRow.appendChild(emptyCell);
      rulesBody.appendChild(emptyRow);
    }
    
    updateStatus(rules.length);
  });
}

function createRuleRow(rule, index) {
  const row = document.createElement('tr');
  row.className = 'rule-row';
  
  const blockCell = document.createElement('td');
  blockCell.textContent = rule.blockURL;
  row.appendChild(blockCell);
  
  const redirectCell = document.createElement('td');
  redirectCell.textContent = rule.redirectURL || '—';
  row.appendChild(redirectCell);
  
  const actionsCell = document.createElement('td');
  actionsCell.className = 'actions';
  
  const editBtn = document.createElement('button');
  editBtn.textContent = browser.i18n.getMessage('editbtn');
  editBtn.addEventListener('click', () => toggleEditMode(row, index, rule));
  actionsCell.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = browser.i18n.getMessage('deletebtn');
  deleteBtn.addEventListener('click', () => deleteRule(index));
  actionsCell.appendChild(deleteBtn);
  
  row.appendChild(actionsCell);
  return row;
}

function deleteRule(index) {
  browser.storage.sync.get('rules', ({ rules }) => {
    rules.splice(index, 1);
    browser.storage.sync.set({ rules }, () => {
      statusElement.textContent = browser.i18n.getMessage('ruleddeleted');
      loadRules();
    });
  });
}

function toggleEditMode(row, index, rule) {
  row.innerHTML = '';
  
  const blockInput = document.createElement('input');
  blockInput.type = 'text';
  blockInput.value = rule.blockURL;
  blockInput.placeholder = browser.i18n.getMessage('blockurl');
  const blockCell = document.createElement('td');
  blockCell.className = 'edit-mode';
  blockCell.appendChild(blockInput);
  row.appendChild(blockCell);
  
  const redirectInput = document.createElement('input');
  redirectInput.type = 'text';
  redirectInput.value = rule.redirectURL;
  redirectInput.placeholder = browser.i18n.getMessage('redirecturl');
  const redirectCell = document.createElement('td');
  redirectCell.className = 'edit-mode';
  redirectCell.appendChild(redirectInput);
  row.appendChild(redirectCell);
  
  const actionsCell = document.createElement('td');
  actionsCell.className = 'actions';
  
  const saveBtn = document.createElement('button');
  saveBtn.className = 'save-btn';
  saveBtn.textContent = browser.i18n.getMessage('savebtn');
  saveBtn.addEventListener('click', () => saveEditedRule(index, blockInput.value, redirectInput.value, row));
  actionsCell.appendChild(saveBtn);
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = browser.i18n.getMessage('cancelbtn');
  cancelBtn.addEventListener('click', () => {
    row.replaceWith(createRuleRow(rule, index));
  });
  actionsCell.appendChild(cancelBtn);
  
  row.appendChild(actionsCell);
}

function saveEditedRule(index, newBlock, newRedirect, row) {
  if (!validateRule(newBlock, newRedirect)) return;
  
  browser.storage.sync.get('rules', ({ rules }) => {
    const trimmedBlock = newBlock.trim();
    const trimmedRedirect = newRedirect.trim();

    const ruleExists = rules.some((r, i) => i !== index && r.blockURL === trimmedBlock && r.redirectURL === trimmedRedirect);
    if (ruleExists) {
      alert(alertRuleExist);
      return;
    }
    
    rules[index] = { blockURL: trimmedBlock, redirectURL: trimmedRedirect };
    browser.storage.sync.set({ rules }, () => {
      statusElement.textContent = browser.i18n.getMessage('ruleupdated');
      loadRules();
    });
  });
}

addRuleButton.addEventListener('click', () => {
  const newRow = document.createElement('tr');
  newRow.className = 'rule-row';
  
  const blockInput = document.createElement('input');
  blockInput.type = 'text';
  blockInput.placeholder = browser.i18n.getMessage('blockurl');
  const blockCell = document.createElement('td');
  blockCell.className = 'edit-mode';
  blockCell.appendChild(blockInput);
  newRow.appendChild(blockCell);
  
  const redirectInput = document.createElement('input');
  redirectInput.type = 'text';
  redirectInput.placeholder = browser.i18n.getMessage('redirecturl');
  const redirectCell = document.createElement('td');
  redirectCell.className = 'edit-mode';
  redirectCell.appendChild(redirectInput);
  newRow.appendChild(redirectCell);
  
  const actionsCell = document.createElement('td');
  actionsCell.className = 'actions';
  
  const saveBtn = document.createElement('button');
  saveBtn.className = 'save-btn';
  saveBtn.textContent = browser.i18n.getMessage('savebtn');
  saveBtn.addEventListener('click', () => saveNewRule(blockInput.value, redirectInput.value, newRow));
  actionsCell.appendChild(saveBtn);
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = browser.i18n.getMessage('cancelbtn');
  cancelBtn.addEventListener('click', () => newRow.remove());
  actionsCell.appendChild(cancelBtn);
  
  newRow.appendChild(actionsCell);
  rulesBody.insertBefore(newRow, rulesBody.firstChild);
});

function saveNewRule(newBlock, newRedirect, row) {
  if (!validateRule(newBlock, newRedirect)) return;
  
  browser.storage.sync.get('rules', ({ rules }) => {
    rules = rules || [];
    const trimmedBlock = newBlock.trim();
    const trimmedRedirect = newRedirect.trim();
    
    const ruleExists = rules.some(r => r.blockURL === trimmedBlock && r.redirectURL === trimmedRedirect);
    if (ruleExists) {
      alert(alertRuleExist);
      return;
    }
    
    rules.push({ blockURL: trimmedBlock, redirectURL: trimmedRedirect });
    browser.storage.sync.set({ rules }, () => {
      statusElement.textContent = browser.i18n.getMessage('rulenewadded');
      loadRules();
    });
  });
}

function validateRule(blockURL, redirectURL) {
  if (blockURL.trim() === '') {
    alert(browser.i18n.getMessage('blockurl'));
    return false;
  }
  if (!isValidAscii(blockURL)) {
    alert(blockUrlOnlyAscii);
    return false;
  }
  if (!isOnlyLowerCase(blockURL)) {
    alert(blockUrlOnlyLower);
    return false;
  }
  if (redirectURL && !isValidURL(redirectURL)) {
    alert(wrongRedirectUrl);
    return false;
  }
  return true;
}

function updateStatus(count) {
  statusElement.textContent = browser.i18n.getMessage('savedrules', count.toString());
}

loadRules();