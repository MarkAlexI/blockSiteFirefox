import { customAlert } from './scripts/customAlert.js';
import { isValidURL } from './scripts/isValidURL.js';
import { isValidAscii } from './scripts/isValidAscii.js';
import { isOnlyLowerCase } from './scripts/isOnlyLowerCase.js';
import { isBlockedURL } from './scripts/isBlockedURL.js';
import { getCurrentTabs } from './scripts/getCurrentTabs.js';
import { closeTabsMatchingRule } from './scripts/closeTabs.js';
import { normalizeUrlFilter } from './scripts/normalizeUrlFilter.js';
import { t } from './scripts/t.js';

const donateSpan = document.getElementById('donate-text');
const donateSpanText = t('donatespantext');
if (donateSpanText) {
  donateSpan.innerText = donateSpanText;
}

const donateButton = document.getElementById('donate-button');
const donateURL = 'https://revolut.me/markalexi';
const donateBtnText = t('donatebtntext');
if (donateBtnText) {
  donateButton.innerText = donateBtnText;
}

donateButton.addEventListener('click', (e) => {
  e.stopPropagation();
  window.open(donateURL, '_blank');
});

const quoteElement = document.getElementById('motivational-quote');

const totalQuotes = 10;
const randomIndex = Math.floor(Math.random() * totalQuotes) + 1;
const quoteKey = `quote${randomIndex}`;

const message = t(quoteKey);
quoteElement.textContent = message || 'Stay motivated!';

const rulesContainer = document.getElementById('rules-container');
const addRuleButton = document.getElementById('add-rule');
const statusOutput = document.getElementById('status');

const feedbackButton = document.getElementById('feedback-btn');

feedbackButton.addEventListener('click', () => {
  const manifest = browser.runtime.getManifest();
  const browserInfo = navigator.userAgent;
  
  const email = 'aacsmi06@gmail.com';
  const sendFeedbackSubject = t('sendfeedbacksubject');
  const sendFeedbackBody = t('sendfeedbackbody');
  const subject = encodeURIComponent(sendFeedbackSubject);
  const body = encodeURIComponent(`Browser: ${browserInfo}\n\nExtension Version: ${manifest.version}\n\n${sendFeedbackBody}`);
  
  const mailtoLink = `mailto:${email}?subject=${subject}&body=${body}`;
  
  window.open(mailtoLink, '_blank');
});

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
      const favIcon = thisTabs[0]?.favIconUrl || 'images/icon-32.png';
      createBlockThisSiteButton(currentUrl, favIcon);
    }
  });
})();

const createBlockThisSiteButton = (url, favIconUrl = 'images/icon-32.png') => {
  if (!url || url.trim() === '') return;
  
  const newButton = document.createElement('button');
  const blockThat = t('blockthat');
  newButton.id = 'block-that';
  newButton.title = `${blockThat} ${url}`;
  newButton.textContent = blockThat;
  
  const icon = document.createElement('img');
  icon.src = favIconUrl;
  icon.alt = 'favicon';
  icon.style.width = '16px';
  icon.style.height = '16px';
  icon.style.marginLeft = '16px';
  icon.style.verticalAlign = 'middle';
  newButton.appendChild(icon);
  
  newButton.addEventListener('click', () => {
    browser.storage.sync.get('rules', ({ rules }) => {
      rules = rules || [];
      
      const alreadyExists = rules.some(rule => rule.blockURL === url);
      if (!alreadyExists) {
        rules.push({ blockURL: url, redirectURL: '' });
        browser.storage.sync.set({ rules }, () => {
          createRuleInputs(url, '');
          const outputText = t('savedrules', ' ' + rules.length + ' ');
          statusOutput.value = outputText;
          customAlert('+ 1');
          
          closeTabsMatchingRule(url);
          
          newButton.remove();
        });
      }
    });
  });
  
  addRuleButton.insertAdjacentElement('afterend', newButton);
};

const wrongRedirectUrl = t('wrongredirecturl');
const blockUrlOnlyAscii = t('blockurlonlyascii');
const blockUrlOnlyLower = t('blockurlonlylower');

function makeInputReadOnly(el) {
  el.readOnly = true;
  el.tabIndex = -1;
  el.placeholder = '';
  el.classList.add('input-readonly');
}

function createRuleInputs(blockURLValue = '', redirectURLValue = '') {
  
  const ruleDiv = document.createElement('div');
  ruleDiv.className = 'rule';
  
  const blockURL = document.createElement('input');
  blockURL.type = 'text';
  blockURL.placeholder = t('blockurl');
  blockURL.value = blockURLValue;
  
  const redirectURL = document.createElement('input');
  redirectURL.type = 'text';
  redirectURL.placeholder = t('redirecturl');
  redirectURL.value = redirectURLValue;
  
  const deleteButton = document.createElement('button');
  deleteButton.className = 'delete-btn';
  deleteButton.textContent = t('deletebtn');
  
  let saveButton;
  
  const createNewRule = () => {
    browser.storage.sync.get('rules', ({ rules }) => {
      rules = rules || [];
      
      const ruleExists = rules.some(rule =>
        rule.blockURL === blockURL.value && rule.redirectURL === redirectURL.value
      );
      
      if (ruleExists) {
        const alertMessage = t('alertruleexist');
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
          const outputText = t('savedrules', ' ' + rules.length + ' ');
          statusOutput.value = outputText;
          makeInputReadOnly(blockURL);
          makeInputReadOnly(redirectURL);
          saveButton && saveButton.remove();
          customAlert('+ 1');
          
          closeTabsMatchingRule(newRule.blockURL);
        });
      }
    });
  }
  
  const createSaveButton = () => {
    saveButton = document.createElement('button');
    saveButton.className = 'save-btn';
    saveButton.textContent = t('savebtn');
    
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
      
      const outputText = t('savedrules', ' ' + rules.length + ' ');
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