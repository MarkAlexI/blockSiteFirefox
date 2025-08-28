import { isValidURL } from '../scripts/isValidURL.js';
import { isValidAscii } from '../scripts/isValidAscii.js';
import { isOnlyLowerCase } from '../scripts/isOnlyLowerCase.js';
import { normalizeUrlFilter } from '../scripts/normalizeUrlFilter.js';
import { t } from '../scripts/t.js';
import { SettingsManager } from './settings.js';

const settingsManager = new SettingsManager();

const rulesBody = document.getElementById('rules-body');
const addRuleButton = document.getElementById('add-rule');
const statusElement = document.getElementById('status');

document.getElementById('options-title').textContent = t('header');
document.getElementById('header-text').textContent = t('header');
addRuleButton.textContent = t('addrule');
document.getElementById('block-url-header').textContent = t('blockurl');
document.getElementById('redirect-url-header').textContent = t('redirecturl');
document.getElementById('actions-header').textContent = t('actionsheader') || 'Дії';

const wrongRedirectUrl = t('wrongredirecturl');
const blockUrlOnlyAscii = t('blockurlonlyascii');
const blockUrlOnlyLower = t('blockurlonlylower');
const alertRuleExist = t('alertruleexist');

async function loadRules() {
  browser.storage.sync.get('rules', async ({ rules }) => {
    rules = rules || [];
    rulesBody.innerHTML = '';
    
    if (rules.some(rule => !rule.id)) {
      try {
        const oldDnrRules = await browser.declarativeNetRequest.getDynamicRules();
        await browser.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: oldDnrRules.map(r => r.id)
        });
        
        const redirectURL = browser.runtime.getURL("blocked.html");
        const newDnrRules = rules.map((rule, i) => {
          const filter = normalizeUrlFilter(rule.blockURL);
          const urlFilter = `||${filter}`;
          return {
            id: i + 1,
            condition: { urlFilter, resourceTypes: ["main_frame"] },
            priority: 100,
            action: rule.redirectURL ? { type: "redirect", redirect: { url: rule.redirectURL } } : { type: "redirect", redirect: { url: redirectURL } }
          };
        });
        
        await browser.declarativeNetRequest.updateDynamicRules({
          addRules: newDnrRules
        });
        
        rules = newDnrRules.map((dnrRule, i) => ({
          id: dnrRule.id,
          blockURL: rules[i].blockURL,
          redirectURL: rules[i].redirectURL
        }));
        browser.storage.sync.set({ rules });
        
        alert(t('rulesmigrated'));
      } catch (e) {
        console.error("Migration error:", e);
        alert(t('errorupdatingrules'));
      }
    }
    
    rules.forEach((rule, index) => {
      const row = createRuleRow(rule, index);
      rulesBody.appendChild(row);
    });
    
    if (rules.length === 0) {
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = 3;
      emptyCell.textContent = t('norules');
      emptyRow.appendChild(emptyCell);
      rulesBody.appendChild(emptyRow);
    }
    
    updateStatus(rules.length);
  });
}

function createRuleRow(rule, index) {
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
  editBtn.addEventListener('click', () => toggleEditMode(row, index, rule));
  actionsCell.appendChild(editBtn);
  
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = t('deletebtn');
  deleteBtn.addEventListener('click', () => handleRuleDeletion(deleteBtn, index, row));
  actionsCell.appendChild(deleteBtn);
  
  row.appendChild(actionsCell);
  return row;
}

function handleRuleDeletion(deleteButton, index, row) {
  browser.storage.sync.get(['settings'], ({ settings }) => {
    const isStrictMode = settings?.mode === 'strict';
    
    if (isStrictMode) {
      startDeleteCountdown(deleteButton, index, row);
    } else {
      deleteRule(index);
    }
  });
}

function startDeleteCountdown(deleteButton, index, row) {
  let countdown = 10;
  const originalText = deleteButton.textContent;
  
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
      deleteButton.disabled = false;
      deleteButton.classList.remove('countdown-active');
      deleteButton.classList.add('delete-ready');
      deleteButton.textContent = `${originalText} ✓`;
      
      const deleteHandler = () => {
        deleteRule(index);
        deleteButton.removeEventListener('click', deleteHandler);
      };
      
      deleteButton.addEventListener('click', deleteHandler);
      
      setTimeout(() => {
        if (row.parentNode) {
          deleteButton.disabled = false;
          deleteButton.classList.remove('delete-ready');
          deleteButton.textContent = originalText;
          deleteButton.removeEventListener('click', deleteHandler);
        }
      }, 5000);
    }
  }, 1000);
  
  const cancelHandler = (e) => {
    if (e.detail === 2) {
      clearInterval(countdownInterval);
      deleteButton.disabled = false;
      deleteButton.classList.remove('countdown-active');
      deleteButton.textContent = originalText;
      deleteButton.removeEventListener('click', cancelHandler);
    }
  };
  
  deleteButton.addEventListener('click', cancelHandler);
}

async function deleteRule(index) {
  browser.storage.sync.get('rules', async ({ rules }) => {
    const ruleToDelete = rules[index];
    if (!ruleToDelete) return;
    
    try {
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleToDelete.id]
      });
      
      rules.splice(index, 1);
      browser.storage.sync.set({ rules }, () => {
        statusElement.textContent = t('ruleddeleted');
        loadRules();
      });
    } catch (e) {
      console.error("DNR remove error:", e);
      alert(t('errorremovingrule'));
    }
  });
}

function toggleEditMode(row, index, rule) {
  row.innerHTML = '';
  
  const blockInput = document.createElement('input');
  blockInput.type = 'text';
  blockInput.value = rule.blockURL;
  blockInput.name = `row${row}index${index}block`;
  blockInput.placeholder = t('blockurl');
  const blockCell = document.createElement('td');
  blockCell.className = 'edit-mode';
  blockCell.appendChild(blockInput);
  row.appendChild(blockCell);
  
  const redirectInput = document.createElement('input');
  redirectInput.type = 'text';
  redirectInput.value = rule.redirectURL;
  redirectInput.name = `row${row}index${index}redirect`;
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
  saveBtn.addEventListener('click', () => saveEditedRule(index, blockInput.value, redirectInput.value, row, rule.id));
  actionsCell.appendChild(saveBtn);
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('cancelbtn');
  cancelBtn.addEventListener('click', () => {
    row.replaceWith(createRuleRow(rule, index));
  });
  actionsCell.appendChild(cancelBtn);
  
  row.appendChild(actionsCell);
}

async function saveEditedRule(index, newBlock, newRedirect, row, oldRuleId) {
  if (!validateRule(newBlock, newRedirect)) return;
  
  browser.storage.sync.get('rules', async ({ rules }) => {
    const trimmedBlock = newBlock.trim();
    const trimmedRedirect = newRedirect.trim();
    
    const ruleExists = rules.some((r, i) => i !== index && r.blockURL === trimmedBlock && r.redirectURL === trimmedRedirect);
    if (ruleExists) {
      alert(alertRuleExist);
      return;
    }
    
    try {
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [oldRuleId]
      });
      
      const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
      const maxId = dnrRules.length ? Math.max(...dnrRules.map(r => r.id)) : 0;
      const newId = maxId + 1;
      
      const filter = normalizeUrlFilter(trimmedBlock);
      const urlFilter = `||${filter}`;
      const action = trimmedRedirect ? { type: "redirect", redirect: { url: trimmedRedirect } } : { type: "redirect", redirect: { url: browser.runtime.getURL("blocked.html") } };
      
      const newDnrRule = {
        id: newId,
        condition: { urlFilter, resourceTypes: ["main_frame"] },
        priority: 100,
        action
      };
      
      await browser.declarativeNetRequest.updateDynamicRules({
        addRules: [newDnrRule]
      });
      
      rules[index] = { id: newId, blockURL: trimmedBlock, redirectURL: trimmedRedirect };
      browser.storage.sync.set({ rules }, () => {
        statusElement.textContent = t('ruleupdated');
        loadRules();
      });
    } catch (e) {
      console.error("DNR edit error:", e);
      alert(t('errorupdatingrule'));
    }
  });
}

addRuleButton.addEventListener('click', () => {
  const newRow = document.createElement('tr');
  newRow.className = 'rule-row';
  
  const blockInput = document.createElement('input');
  blockInput.type = 'text';
  blockInput.placeholder = t('blockurl');
  const blockCell = document.createElement('td');
  blockCell.className = 'edit-mode';
  blockCell.appendChild(blockInput);
  newRow.appendChild(blockCell);
  
  const redirectInput = document.createElement('input');
  redirectInput.type = 'text';
  redirectInput.placeholder = t('redirecturl');
  const redirectCell = document.createElement('td');
  redirectCell.className = 'edit-mode';
  redirectCell.appendChild(redirectInput);
  newRow.appendChild(redirectCell);
  
  const actionsCell = document.createElement('td');
  actionsCell.className = 'actions';
  
  const saveBtn = document.createElement('button');
  saveBtn.className = 'save-btn';
  saveBtn.textContent = t('savebtn');
  saveBtn.addEventListener('click', async () => saveNewRule(blockInput.value, redirectInput.value, newRow));
  actionsCell.appendChild(saveBtn);
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('cancelbtn');
  cancelBtn.addEventListener('click', () => newRow.remove());
  actionsCell.appendChild(cancelBtn);
  
  newRow.appendChild(actionsCell);
  rulesBody.insertBefore(newRow, rulesBody.firstChild);
});

async function saveNewRule(newBlock, newRedirect, row) {
  if (!validateRule(newBlock, newRedirect)) return;
  
  browser.storage.sync.get('rules', async ({ rules }) => {
    rules = rules || [];
    const trimmedBlock = newBlock.trim();
    const trimmedRedirect = newRedirect.trim();
    
    const ruleExists = rules.some(r => r.blockURL === trimmedBlock && r.redirectURL === trimmedRedirect);
    if (ruleExists) {
      alert(alertRuleExist);
      return;
    }
    
    try {
      const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
      const maxId = dnrRules.length ? Math.max(...dnrRules.map(r => r.id)) : 0;
      const newId = maxId + 1;
      
      const filter = normalizeUrlFilter(trimmedBlock);
      const urlFilter = `||${filter}`;
      const action = trimmedRedirect ? { type: "redirect", redirect: { url: trimmedRedirect } } : { type: "redirect", redirect: { url: browser.runtime.getURL("blocked.html") } };
      
      const newDnrRule = {
        id: newId,
        condition: { urlFilter, resourceTypes: ["main_frame"] },
        priority: 100,
        action
      };
      
      await browser.declarativeNetRequest.updateDynamicRules({
        addRules: [newDnrRule]
      });
      
      rules.push({ id: newId, blockURL: trimmedBlock, redirectURL: trimmedRedirect });
      browser.storage.sync.set({ rules }, () => {
        statusElement.textContent = t('rulenewadded');
        loadRules();
      });
    } catch (e) {
      console.error("DNR add error:", e);
      alert(t('erroraddingrule'));
    }
  });
}

function validateRule(blockURL, redirectURL) {
  if (blockURL.trim() === '') {
    alert(t('blockurl'));
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
  statusElement.textContent = t('savedrules', count.toString());
}

loadRules();