import { customAlert } from './scripts/customAlert.js';
import { isBlockedURL } from './scripts/isBlockedURL.js';
import { getCurrentTabs } from './scripts/getCurrentTabs.js';
import { closeTabsMatchingRule } from './scripts/closeTabs.js';
import { normalizeUrlFilter } from './scripts/normalizeUrlFilter.js';
import { t } from './scripts/t.js';
import { RulesManager } from './rules/rulesManager.js';
import { RulesUI } from './rules/rulesUI.js';

class PopupPage {
  constructor() {
    this.rulesManager = new RulesManager();
    this.rulesUI = new RulesUI();
    
    this.rulesContainer = document.getElementById('rules-container');
    this.addRuleButton = document.getElementById('add-rule');
    this.statusOutput = document.getElementById('status');
    this.currentModeElement = document.getElementById('current-mode');
    
    this.thisTabs = [];
    
    this.init();
  }
  
  async init() {
    this.initializeUI();
    this.setupEventListeners();
    await this.loadSecurityMode();
    await this.loadCurrentTabs();
    await this.loadRules();
  }
  
  initializeUI() {
    const donateSpan = document.getElementById('donate-text');
    const donateSpanText = t('donatespantext');
    if (donateSpanText) {
      donateSpan.innerText = donateSpanText;
    }
    
    const donateButton = document.getElementById('donate-button');
    const donateBtnText = t('donatebtntext');
    if (donateBtnText) {
      donateButton.innerText = donateBtnText;
    }
    
    this.setupMotivationalQuote();
  }
  
  setupMotivationalQuote() {
    const quoteElement = document.getElementById('motivational-quote');
    const totalQuotes = 10;
    const randomIndex = Math.floor(Math.random() * totalQuotes) + 1;
    const quoteKey = `quote${randomIndex}`;
    const message = t(quoteKey);
    quoteElement.textContent = message || 'Stay motivated!';
  }
  
  async loadSecurityMode() {
    try {
      const result = await browser.storage.sync.get(['settings']);
      const settings = result.settings || {};
      const mode = settings.mode || 'normal';
      
      if (this.currentModeElement) {
        if (mode === 'strict') {
          this.currentModeElement.setAttribute('data-i18n', 'strictmodetitle');
          this.currentModeElement.textContent = t('strictmodetitle') || 'Strict Mode';
          this.currentModeElement.className = 'strict-mode';
        } else {
          this.currentModeElement.setAttribute('data-i18n', 'normalmodetitle');
          this.currentModeElement.textContent = t('normalmodetitle') || 'Normal Mode';
          this.currentModeElement.className = 'normal-mode';
        }
      }
      
    } catch (error) {
      console.error('Error loading security mode:', error);
      if (this.currentModeElement) {
        this.currentModeElement.setAttribute('data-i18n', 'normalmodetitle');
        this.currentModeElement.textContent = t('normalmodetitle') || 'Normal Mode';
        this.currentModeElement.className = 'normal-mode';
      }
    }
  }
  
  setupEventListeners() {
    const optionsLink = document.getElementById('options-link');
    optionsLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.openOptionsPage();
    });
    
    const donateButton = document.getElementById('donate-button');
    const donateURL = 'https://revolut.me/markalexi';
    
    donateButton.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(donateURL, '_blank');
    });
    
    const feedbackButton = document.getElementById('feedback-btn');
    feedbackButton.addEventListener('click', () => {
      this.openFeedbackEmail();
    });
    
    this.addRuleButton.addEventListener('click', () => {
      this.createRuleInputs();
    });
    
    browser.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && changes.settings) {
        this.loadSecurityMode();
      }
    });
  }
  
  async openOptionsPage() {
    const currentTab = await browser.tabs.getCurrent();
    
    if (browser && browser.runtime && browser.runtime.openOptionsPage) {
      try {
        await browser.runtime.openOptionsPage();

        const tabs = await browser.tabs.query({ currentWindow: true });
        const optionsTab = tabs[tabs.length - 1];
        if (optionsTab && optionsTab.url.includes('options.html')) {
          await browser.tabs.update(optionsTab.id, { active: true });
        }
      } catch (error) {
        console.info('Error with openOptionsPage:', error);

        const optionsUrl = browser.runtime.getURL('options/options.html');
        const newTab = await browser.tabs.create({ url: optionsUrl });
        await browser.tabs.update(newTab.id, { active: true });
      }
    } else {
      const optionsUrl = browser.runtime.getURL('options/options.html');
      const newTab = await browser.tabs.create({ url: optionsUrl });
      await browser.tabs.update(newTab.id, { active: true });
    }

    if (currentTab && currentTab.id) {
      setTimeout(() => {
        browser.tabs.remove(currentTab.id).catch(err => console.error('Error closing popup tab:', err));
      }, 200);
    }
  }
  
  openFeedbackEmail() {
    const manifest = browser.runtime.getManifest();
    const browserInfo = navigator.userAgent;
    
    const email = 'aacsmi06@gmail.com';
    const sendFeedbackSubject = t('sendfeedbacksubject');
    const sendFeedbackBody = t('sendfeedbackbody');
    const subject = encodeURIComponent(sendFeedbackSubject);
    const body = encodeURIComponent(`Browser: ${browserInfo}\n\nExtension Version: ${manifest.version}\n\n${sendFeedbackBody}`);
    
    const mailtoLink = `mailto:${email}?subject=${subject}&body=${body}`;
    window.open(mailtoLink, '_blank');
  }
  
  async loadCurrentTabs() {
    this.thisTabs = await getCurrentTabs();
  }
  
  async loadRules() {
    try {
      const migrationResult = await this.rulesManager.migrateRules();
      if (migrationResult.migrated) {
        customAlert(t('rulesmigrated'));
      }
      
      const rules = migrationResult.rules || await this.rulesManager.getRules();
      
      this.rulesContainer.innerHTML = '';
      
      rules.forEach(rule => {
        this.createRuleInputs(rule.blockURL, rule.redirectURL, rule.id);
      });
      
      this.updateStatus(rules.length);
      this.showBlockThisSiteButton(rules);
      
    } catch (error) {
      console.error("Load rules error:", error);
      customAlert(t('errorupdatingrules'));
    }
  }
  
  showBlockThisSiteButton(rules) {
    const existingButton = document.getElementById('block-that');
    if (existingButton) {
      existingButton.remove();
    }
    
    const currentUrl = normalizeUrlFilter(this.thisTabs[0]?.url || '');
    const alreadyBlocked = rules.some(rule => rule.blockURL === currentUrl);
    
    if (!isBlockedURL(this.thisTabs) && !alreadyBlocked && currentUrl) {
      const favIcon = this.thisTabs[0]?.favIconUrl || 'images/icon-32.png';
      this.createBlockThisSiteButton(currentUrl, favIcon);
    }
  }
  
  createBlockThisSiteButton(url, favIconUrl = 'images/icon-32.png') {
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
    
    if (this.isTouchDevice()) {
      const domain = this.extractDomain(url);
      const domainDiv = document.createElement('div');
      domainDiv.className = 'site-domain';
      domainDiv.textContent = `(${domain})`;
      newButton.appendChild(domainDiv);
    }
    
    newButton.addEventListener('click', async () => {
      await this.blockCurrentSite(url, newButton);
    });
    
    this.addRuleButton.insertAdjacentElement('afterend', newButton);
  }
  
  isTouchDevice() {
    return ('ontouchstart' in window) ||
      (navigator.maxTouchPoints > 0) ||
      (navigator.msMaxTouchPoints > 0);
  }
  
  extractDomain(url) {
    try {
      let domain = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
      domain = domain.split('/')[0];
      return domain.length > 20 ? domain.substring(0, 17) + '...' : domain;
    } catch (error) {
      return url.substring(0, 20) + (url.length > 20 ? '...' : '');
    }
  }
  
  async blockCurrentSite(url, button) {
    try {
      const rules = await this.rulesManager.getRules();
      const alreadyExists = rules.some(rule => rule.blockURL === url);
      
      if (!alreadyExists) {
        await this.rulesManager.addRule(url, '');
        
        const updatedRules = await this.rulesManager.getRules();
        const newRule = updatedRules.find(rule => rule.blockURL === url);
        
        this.createRuleInputs(url, '', newRule.id);
        this.updateStatus(updatedRules.length);
        customAlert('+ 1');
        
        closeTabsMatchingRule(url);
        button.remove();
      }
    } catch (error) {
      console.error("Block current site error:", error);
      customAlert(t('erroraddingrule'));
    }
  }
  
  createRuleInputs(blockURLValue = '', redirectURLValue = '', ruleId = null) {
    const ruleDiv = document.createElement('div');
    ruleDiv.className = 'rule';
    ruleDiv.dataset.ruleId = ruleId;
    
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
    
    deleteButton.addEventListener('click', async () => {
      await this.handleRuleDeletion(deleteButton, blockURL.value, redirectURL.value, ruleDiv);
    });
    
    setTimeout(() => {
      ruleDiv.appendChild(blockURL);
      ruleDiv.appendChild(redirectURL);
      
      if (!blockURLValue) {
        const saveButton = this.createSaveButton(blockURL, redirectURL, ruleDiv);
        ruleDiv.appendChild(saveButton);
      } else {
        this.makeInputReadOnly(blockURL);
        this.makeInputReadOnly(redirectURL);
      }
      
      ruleDiv.appendChild(deleteButton);
      this.rulesContainer.insertAdjacentElement('afterbegin', ruleDiv);
    }, 0);
  }
  
  createSaveButton(blockURL, redirectURL, ruleDiv) {
    const saveButton = document.createElement('button');
    saveButton.className = 'save-btn';
    saveButton.textContent = t('savebtn');
    
    saveButton.addEventListener('click', async () => {
      await this.saveNewRule(blockURL, redirectURL, ruleDiv, saveButton);
    });
    
    return saveButton;
  }
  
  async saveNewRule(blockURL, redirectURL, ruleDiv, saveButton) {
    try {
      const rules = await this.rulesManager.getRules();
      const ruleExists = rules.some(rule =>
        rule.blockURL === blockURL.value.trim() && rule.redirectURL === redirectURL.value.trim()
      );
      
      if (ruleExists) {
        customAlert(t('alertruleexist'));
        blockURL.value = '';
        redirectURL.value = '';
        return;
      }
      
      await this.rulesManager.addRule(blockURL.value, redirectURL.value);
      
      const updatedRules = await this.rulesManager.getRules();
      this.createRuleInputs();
      this.updateStatus(updatedRules.length);
      
      this.makeInputReadOnly(blockURL);
      this.makeInputReadOnly(redirectURL);
      saveButton.remove();
      
      customAlert('+ 1');
      closeTabsMatchingRule(blockURL.value.trim());
      
    } catch (error) {
      console.error("Save new rule error:", error);
      
      if (error.message.includes('Validation failed')) {
        const errors = error.message.replace('Validation failed: ', '').split(', ');
        this.rulesUI.showValidationErrors(errors);
      } else if (error.message === 'Rule already exists') {
        customAlert(t('alertruleexist'));
        blockURL.value = '';
        redirectURL.value = '';
      } else {
        customAlert(t('erroraddingrule'));
      }
    }
  }
  
  async handleRuleDeletion(deleteButton, blockURL, redirectURL, ruleDiv) {
    try {
      const isStrictMode = await this.rulesManager.isStrictMode();
      
      this.rulesUI.handleRuleDeletion(
        deleteButton,
        async () => {
            try {
              await this.rulesManager.deleteRuleByData(blockURL, redirectURL);
              
              const updatedRules = await this.rulesManager.getRules();
              this.updateStatus(updatedRules.length);
              
              if (blockURL) {
                customAlert('- 1');
              }
              ruleDiv.remove();
              
            } catch (error) {
              console.error("Delete rule error:", error);
              customAlert(t('errorremovingrule'));
            }
          },
          isStrictMode,
          t('deletebtn')
      );
      
    } catch (error) {
      console.error("Handle deletion error:", error);
      customAlert(t('errorremovingrule'));
    }
  }
  
  makeInputReadOnly(input) {
    input.readOnly = true;
    input.tabIndex = -1;
    input.placeholder = '';
    input.classList.add('input-readonly');
  }
  
  updateStatus(count) {
    const outputText = t('savedrules', ' ' + count + ' ');
    this.statusOutput.value = outputText;
  }
  
  cleanup() {
    this.rulesUI.cleanup();
    if (browser.storage && browser.storage.onChanged) {
      browser.storage.onChanged.removeListener(this.storageChangeListener);
    }
  }
}

const popupPage = new PopupPage();

window.addEventListener('beforeunload', () => {
  popupPage.cleanup();
});

browser.runtime.getBrowserInfo().then(info => {
  if (parseInt(info.version) < 128) {
    document.getElementById('warning-info').classList.remove('hidden');
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'reload_rules') {
    popupPage.loadRules();
  }
  
  if (message.type === 'pro_status_changed') {
    console.log(`Pro status changed: ${message.isPro}`);
    
    ProManager.updateProFeaturesVisibility(message.isPro);
    
    sendResponse({ received: true });
  }
});