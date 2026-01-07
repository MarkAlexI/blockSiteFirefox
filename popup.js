import { customAlert } from './scripts/customAlert.js';
import { isBlockedURL } from './scripts/isBlockedURL.js';
import { getCurrentTabs } from './scripts/getCurrentTabs.js';
import { normalizeDomainRule } from './rules/normalizeDomainRule.js';
import { t } from './scripts/t.js';
import { RulesManager } from './rules/rulesManager.js';
import { RulesUI } from './rules/rulesUI.js';
import { ProManager } from './pro/proManager.js';
import { PasswordUtils } from './pro/password.js';
import { initializeNoSpaceInputs } from './utils/noSpaces.js';
import Logger from '../utils/logger.js';

const MAX_RULES_LIMIT = 5;
const logger = new Logger('Popup');

class PopupPage {
  constructor() {
    this.logger = logger;
    this.rulesManager = new RulesManager();
    this.rulesUI = new RulesUI();
    
    this.rulesContainer = document.getElementById('rules-container');
    this.addRuleButton = document.getElementById('add-rule');
    this.statusOutput = document.getElementById('status');
    this.currentModeElement = document.getElementById('current-mode');
    
    this.thisTabs = [];
    this.settings = {};
    
    this.currentRuleCount = 0;
    
    this.init();
  }
  
  async init() {
    this.initializeUI();
    this.setupEventListeners();
    await this.loadSettings();
    await this.loadCurrentTabs();
    
    try {
      this.isPro = await ProManager.isPro();
      this.isLegacyUser = await ProManager.isLegacyUser();
    } catch (error) {
      this.logger.info('Error initializing Pro/Legacy status:', error);
    }
    
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
    const totalQuotes = 20;
    const randomIndex = Math.floor(Math.random() * totalQuotes) + 1;
    const quoteKey = `quote${randomIndex}`;
    const message = t(quoteKey);
    quoteElement.textContent = message || 'Stay motivated!';
  }
  
  async loadSettings() {
    try {
      const result = await browser.storage.sync.get(['settings']);
      this.settings = result.settings || {};
      const mode = this.settings.mode || 'normal';
      
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
      this.logger.error('Error loading security mode:', error);
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
    
    this.addRuleButton.addEventListener('click', async () => {
      if (!this.isPro && !this.isLegacyUser) {
        const rules = await this.rulesManager.getRules();
        this.currentRuleCount = rules.length;
        
        if (this.currentRuleCount >= MAX_RULES_LIMIT) {
          customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
      this.createRuleInputs();
    });
    
    browser.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && changes.settings) {
        this.loadSettings();
      }
    });
  }
  
  openOptionsPage() {
    const closePopup = () => {
      setTimeout(() => {
        window.close();
      }, 100);
    };
    
    if (browser.runtime.openOptionsPage) {
      browser.runtime.openOptionsPage(() => {
        closePopup();
      });
    } else {
      browser.tabs.create({ url: browser.runtime.getURL('options/options.html') }, () => {
        closePopup();
      });
    }
  }
  
  openFeedbackEmail() {
    const manifest = browser.runtime.getManifest();
    const browserInfo = navigator.userAgent;
    
    const email = 'support@blockdistraction.com';
    const subject = encodeURIComponent(t('sendfeedbacksubject'));
    const body = encodeURIComponent(
      `Browser: ${browserInfo}\n\nExtension Version: ${manifest.version}\n\n${t('sendfeedbackbody')}`
    );
    
    const mailtoLink = `mailto:${email}?subject=${subject}&body=${body}`;
    
    const link = document.createElement('a');
    link.href = mailtoLink;
    link.target = "_top";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
      
      this.currentRuleCount = rules.length;
      
      this.rulesContainer.innerHTML = '';
      
      rules.forEach(rule => {
        this.createRuleInputs(rule.blockURL, rule.redirectURL, rule.id);
      });
      
      this.updateStatus(rules.length);
      this.showBlockThisSiteButton(rules);
      
    } catch (error) {
      this.logger.error("Load rules error:", error);
      customAlert(t('errorupdatingrules'));
    }
  }
  
  showBlockThisSiteButton(rules) {
    const existingButton = document.getElementById('block-that');
    if (existingButton) {
      existingButton.remove();
    }
    
    const currentUrl = normalizeDomainRule(this.thisTabs[0]?.url || '');
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
      if (!this.isPro && !this.isLegacyUser) {
        const rules = await this.rulesManager.getRules();
        if (rules.length >= MAX_RULES_LIMIT) {
          customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
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
        if (!this.isPro && !this.isLegacyUser) {
          if (rules.length >= MAX_RULES_LIMIT) {
            customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
            return;
          }
        }
        
        await this.rulesManager.addRule(url, '');
        
        await this.loadRules();
        
        customAlert('+ 1');
        browser.runtime.sendMessage({
          type: 'CLOSE_MATCHING_TABS',
          url: url
        });
        button.remove();
      }
    } catch (error) {
      this.logger.error("Block current site error:", error);
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
    
    let showButtons = true;
    
    if (!blockURLValue) {
      const isFreeUser = !this.isPro && !this.isLegacyUser;
      if (isFreeUser && this.currentRuleCount >= MAX_RULES_LIMIT) {
        showButtons = false;
      }
    }
    
    setTimeout(() => {
      ruleDiv.appendChild(blockURL);
      ruleDiv.appendChild(redirectURL);
      
      if (!blockURLValue) {
        if (showButtons) {
          const saveButton = this.createSaveButton(blockURL, redirectURL, ruleDiv);
          ruleDiv.appendChild(saveButton);
        } else {
          const proMessage = document.createElement('span');
          proMessage.textContent = t('proonlyactions') || 'Upgrade to add more';
          proMessage.className = 'pro-message';
          ruleDiv.appendChild(proMessage);
        }
      } else {
        this.makeInputReadOnly(blockURL);
        this.makeInputReadOnly(redirectURL);
      }
      
      if (blockURLValue || (showButtons && !blockURLValue)) {
        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete-btn';
        deleteButton.textContent = t('deletebtn');
        
        deleteButton.addEventListener('click', async () => {
          await this.handleRuleDeletion(deleteButton, blockURL.value, redirectURL.value, ruleDiv);
        });
        
        ruleDiv.appendChild(deleteButton);
      }
      
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
      if (!this.isPro && !this.isLegacyUser) {
        const currentRules = await this.rulesManager.getRules();
        if (currentRules.length >= MAX_RULES_LIMIT) {
          customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
      
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
      this.currentRuleCount = updatedRules.length;
      this.updateStatus(updatedRules.length);
      
      ruleDiv.remove();
      
      const newRule = updatedRules.find(r => r.blockURL === blockURL.value.trim());
      if (newRule) {
        this.createRuleInputs(newRule.blockURL, newRule.redirectURL, newRule.id);
      }
      
      const canAddMore = this.isPro || this.isLegacyUser || (updatedRules.length < MAX_RULES_LIMIT);
      
      if (canAddMore) {
        this.createRuleInputs();
      }
      
      customAlert('+ 1');
      browser.runtime.sendMessage({
        type: 'CLOSE_MATCHING_TABS',
        url: blockURL.value.trim()
      });
    } catch (error) {
      this.logger.error("Save new rule error:", error);
      
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
      if (!blockURL) {
        ruleDiv.remove();
        return;
      }
      
      if (this.settings.enablePassword && this.isPro) {
        const isValid = await this.promptForPassword();
        if (!isValid) {
          customAlert(t('invalidpassword'));
          return;
        }
      }
      
      const isStrictMode = await this.rulesManager.isStrictMode();
      
      this.rulesUI.handleRuleDeletion(
        deleteButton,
        async () => {
            try {
              if (blockURL) {
                await this.rulesManager.deleteRuleByData(blockURL, redirectURL);
                
                await this.loadRules();
                
                const rules = await this.rulesManager.getRules();
                const canAddMore = this.isPro || this.isLegacyUser || (rules.length < MAX_RULES_LIMIT);
                
                const firstInput = this.rulesContainer.querySelector('input[type="text"]');
                const isFirstEmpty = firstInput && !firstInput.value;
                
                if (canAddMore && !isFirstEmpty) {
                  this.createRuleInputs();
                }
                
                customAlert('- 1');
              } else {
                ruleDiv.remove();
              }
              
            } catch (error) {
              this.logger.info("Delete rule error:", error);
              ruleDiv.remove();
            }
          },
          isStrictMode,
          t('deletebtn')
      );
      
    } catch (error) {
      this.logger.error("Handle deletion error:", error);
      customAlert(t('errorremovingrule'));
    }
  }
  
  async promptForPassword() {
    return new Promise((resolve) => {
      PasswordUtils.showPasswordModal('verify', (isValid) => {
        resolve(isValid);
      }, t);
    });
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
    logger.log(`Pro status changed: ${message.isPro}`);
    
    ProManager.updateProFeaturesVisibility(message.isPro);
    popupPage.isPro = message.isPro;
    
    popupPage.loadRules();
    
    sendResponse({ received: true });
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initializeNoSpaceInputs();
});