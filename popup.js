"use strict";

const rulesContainer = document.getElementById('rules-container');
const addRuleButton = document.getElementById('add-rule');
const statusOutput = document.getElementById('status');

chrome.storage.sync.get('rules', ({ rules }) => {
  if (rules) {
    rules.forEach(rule => {
      createRuleInputs(rule.blockURL, rule.redirectURL);
    });
  }
});

function createRuleInputs(blockURLValue = '', redirectURLValue = '') {
  
  const ruleDiv = document.createElement('div');
  ruleDiv.className = 'rule';

  const blockURL = document.createElement('input');
  blockURL.type = 'text';
  blockURL.placeholder = 'Type block URL'
  blockURL.value = blockURLValue;

  const redirectURL = document.createElement('input');
  redirectURL.type = 'text';
  redirectURL.placeholder = 'Type redirect URL'
  redirectURL.value = redirectURLValue;

  const saveButton = document.createElement('button');
  saveButton.className = 'save-btn';
  saveButton.textContent = 'Save';

  const deleteButton = document.createElement('button');
  deleteButton.className = 'delete-btn';
  deleteButton.textContent = 'Delete';

  saveButton.addEventListener('click', () => {
    if (blockURL.value === '') return;
    
    chrome.storage.sync.get('rules', ({ rules }) => {
      rules = rules || [];

      const ruleExists = rules.some(rule =>
        rule.blockURL === blockURL.value && rule.redirectURL === redirectURL.value
      );

      if (ruleExists) {
        alert('Rule now exist');
      } else {
        rules.push({ blockURL: blockURL.value, redirectURL: redirectURL.value });
        chrome.storage.sync.set({ rules }, () => {
          createRuleInputs();
          statusOutput.value = `Saved ${rules.length} rules`;
        });
      }
    });
  });

  deleteButton.addEventListener('click', () => {
    chrome.storage.sync.get('rules', ({ rules }) => {
      rules = rules || [];
      rules = rules.filter((rule) => rule.blockURL !== blockURL.value);
      chrome.storage.sync.set({ rules });
      statusOutput.value = `Saved ${rules.length} rules`;
    });
    ruleDiv.remove();
  });

  ruleDiv.appendChild(blockURL);
  ruleDiv.appendChild(redirectURL);
  ruleDiv.appendChild(saveButton);
  ruleDiv.appendChild(deleteButton);

  rulesContainer.appendChild(ruleDiv);
}

addRuleButton.addEventListener('click', () => {
  createRuleInputs();
});