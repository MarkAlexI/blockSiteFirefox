import { customAlert } from './scripts/customAlert.js';
import { isValidURL } from './scripts/isValidURL.js';
import { isValidAscii } from './scripts/isValidAscii.js';
import { isOnlyLowerCase } from './scripts/isOnlyLowerCase.js';
import { isBlockedURL } from './scripts/isBlockedURL.js';
import { getCurrentTabs } from './scripts/getCurrentTabs.js';

const donateSpan = document.getElementById('donate-text');
const donateSpanText = browser.i18n.getMessage('donatespantext');
if (donateSpanText) {
  donateSpan.innerText = donateSpanText;
}

const donateButton = document.getElementById('donate-button');
const donateURL = 'https://revolut.me/markalexi';
const donateBtnText = browser.i18n.getMessage('donatebtntext');
if (donateBtnText) {
  donateButton.innerText = donateBtnText;
}

donateButton.addEventListener('click', (e) => {
  e.stopPropagation();
  window.open(donateURL, '_blank');
});

const rulesContainer = document.getElementById('rules-container');
const addRuleButton = document.getElementById('add-rule');
const statusOutput = document.getElementById('status');

let thisTabs = [];

(async () => {
  thisTabs = await getCurrentTabs();
  
  browser.storage.sync.get('rules', ({ rules }) => {
    rules = rules || [];
    
    rules.forEach(rule => {
      createRuleInputs(rule.blockURL, rule.redirectURL);
    });
    
    const currentUrl = normalizeUrlFilter(thisTabs[0]?.url || '');
    const alreadyBlocked = rules.some(rule => rule.blockURL === currentUrl);
    
    if (!isBlockedURL(thisTabs) && !alreadyBlocked) {
      createBlockThisSiteButton(currentUrl);
    }
  });
})();

//add favicon
const createBlockThisSiteButton = (url) => {
  if (!url || url.trim() === '') return;

  const newButton = document.createElement('button');
  newButton.id = 'block-that';
  newButton.textContent = browser.i18n.getMessage('blockthat');
  
  newButton.addEventListener('click', () => {
    browser.storage.sync.get('rules', ({ rules }) => {
      rules = rules || [];
      
      const alreadyExists = rules.some(rule => rule.blockURL === url);
      if (!alreadyExists) {
        rules.push({ blockURL: url, redirectURL: '' });
        browser.storage.sync.set({ rules }, () => {
          createRuleInputs(url, '');
          const outputText = browser.i18n.getMessage('savedrules', ' ' + rules.length + ' ');
          statusOutput.value = outputText;
          customAlert('+ 1');
          
          newButton.remove();
        });
      }
    });
  });
  
  addRuleButton.insertAdjacentElement('afterend', newButton);
};

const wrongRedirectUrl = browser.i18n.getMessage('wrongredirecturl');
const blockUrlOnlyAscii = browser.i18n.getMessage('blockurlonlyascii');
const blockUrlOnlyLower = browser.i18n.getMessage('blockurlonlylower');

function makeInputReadOnly(el) {
  el.inert = true;
  el.placeholder = '';
  el.classList.add('input-readonly');
}

function createRuleInputs(blockURLValue = '', redirectURLValue = '') {
  
  const ruleDiv = document.createElement('div');
  ruleDiv.className = 'rule';
  
  const blockURL = document.createElement('input');
  blockURL.type = 'text';
  blockURL.placeholder = browser.i18n.getMessage('blockurl');
  blockURL.value = blockURLValue;
  
  const redirectURL = document.createElement('input');
  redirectURL.type = 'text';
  redirectURL.placeholder = browser.i18n.getMessage('redirecturl');
  redirectURL.value = redirectURLValue;
  
  const deleteButton = document.createElement('button');
  deleteButton.className = 'delete-btn';
  deleteButton.textContent = browser.i18n.getMessage('deletebtn');
  
  let saveButton;
  
  const createNewRule = () => {
    browser.storage.sync.get('rules', ({ rules }) => {
      rules = rules || [];
      
      const ruleExists = rules.some(rule =>
        rule.blockURL === blockURL.value && rule.redirectURL === redirectURL.value
      );
      
      if (ruleExists) {
        const alertMessage = browser.i18n.getMessage('alertruleexist');
        customAlert(alertMessage);
        blockURL.value = '';
        redirectURL.value = '';
      } else {
        if (redirectURL.value) {
          if (!isValidURL(redirectURL.value)) {
            customAlert(wrongRedirectUrl);
            return;
          }
        }
        
        rules.push({ blockURL: blockURL.value.trim(), redirectURL: redirectURL.value.trim() });
        browser.storage.sync.set({ rules }, () => {
          createRuleInputs();
          const outputText = browser.i18n.getMessage('savedrules', ' ' + rules.length + ' ');
          statusOutput.value = outputText;
          makeInputReadOnly(blockURL);
          makeInputReadOnly(redirectURL);
          saveButton && saveButton.remove();
          customAlert('+ 1');
        });
      }
    });
  }
  
  const createSaveButton = () => {
    saveButton = document.createElement('button');
    saveButton.className = 'save-btn';
    saveButton.textContent = browser.i18n.getMessage('savebtn');
    
    saveButton.addEventListener('click', () => {
      if (blockURL.value === '') {
        customAlert(blockURL.placeholder);
        return;
      }
      if (!isValidAscii(blockURL.value)) {
        customAlert(blockUrlOnlyAscii);
        return;
      }
      if (!isOnlyLowerCase(blockURL.value)) {
        customAlert(blockUrlOnlyLower);
        return;
      }
      
      createNewRule();
    });
    
    return saveButton;
  };
  
  deleteButton.addEventListener('click', () => {
    browser.storage.sync.get('rules', ({ rules }) => {
      rules = rules || [];
      rules = rules.filter((rule) => rule.blockURL !== blockURL.value.trim() || rule.redirectURL !== redirectURL.value.trim());
      browser.storage.sync.set({ rules });
      
      const outputText = browser.i18n.getMessage('savedrules', ' ' + rules.length + ' ');
      statusOutput.value = outputText;
    });
    if (blockURL.value) {
      customAlert('- 1');
    }
    ruleDiv.remove();
  });
  
  setTimeout(function() {
    ruleDiv.appendChild(blockURL);
    ruleDiv.appendChild(redirectURL);
    if (!blockURLValue) {
      const saveButton = createSaveButton();
      ruleDiv.appendChild(saveButton);
    } else {
      makeInputReadOnly(blockURL);
      makeInputReadOnly(redirectURL);
    }
    ruleDiv.appendChild(deleteButton);
    
    rulesContainer.insertAdjacentElement('afterbegin', ruleDiv);
  }, 0);
}

addRuleButton.addEventListener('click', () => {
  createRuleInputs();
});

browser.runtime.getBrowserInfo().then(info => {
  if (parseInt(info.version) < 128) {
    document.getElementById('warning-info').classList.remove('hidden');
  }
});