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
import Logger from './utils/logger.js';
import { getFocusSessionState } from './utils/focusSession.js';
import { MAX_RULES_LIMIT } from './utils/constants.js';
import { scrollToTop, mountScroll } from './dom/scrollToTop.js';
import { ScheduleFormatter } from './utils/scheduleFormatter.js';

const logger = new Logger('Popup');

class PopupPage {
  constructor() {
    this.logger = logger;
    this.rulesManager = new RulesManager();
    this.rulesUI = new RulesUI();
    this.scheduleFormatter = new ScheduleFormatter();
    
    this.rulesContainer = document.getElementById('rules-container');
    this.addRuleButton = document.getElementById('add-rule');
    this.addWhitelistRuleButton = document.getElementById('add-whitelist-rule');
    this.statusOutput = document.getElementById('status');
    this.currentModeElement = document.getElementById('current-mode');
    this.scrollToTopBtn = document.getElementById('scrollToTopBtn');
    
    this.focusSection = document.getElementById('focus-session-section');
    this.startFocusBtn = document.getElementById('start-focus-btn');
    this.stopFocusBtn = document.getElementById('stop-focus-btn');
    this.focusDurationInput = document.getElementById('focus-duration');
    this.focusTimerDisplay = document.getElementById('focus-timer-display');
    this.focusStartView = document.getElementById('focus-start-view');
    this.focusActiveView = document.getElementById('focus-active-view');
    this.focusProNote = document.getElementById('focus-pro-note');
    this.focusModeControl = document.getElementById('focus-mode-control');
    this.focusModeSelect = document.getElementById('focus-mode-select');
    this.hardcoreModeControl = document.getElementById('hardcore-mode-control');
    this.hardcoreModeCheckbox = document.getElementById('focus-hardcore-mode');
    this.focusTimerInterval = null;
    
    this.thisTabs = [];
    this.settings = {};
    
    this.currentRuleCount = 0;
    this.isPro = false;
    this.isLegacyUser = false;
    
    this.init();
  }
  
  async init() {
    this.initializeUI();
    this.setupEventListeners();
    await this.loadSettings();
    await this.loadCurrentTabs();
    mountScroll(this.currentModeElement, this.scrollToTopBtn);
    
    try {
      this.isPro = await ProManager.isPro();
      this.isLegacyUser = await ProManager.isLegacyUser();
    } catch (error) {
      this.logger.info('Error initializing Pro/Legacy status:', error);
    }
    
    this.updateWhitelistButtonState();
    
    await this.loadRules();
    await this.initFocusSession();
  }
  
  initializeUI() {
    this.setupMotivationalQuote();
  }
  
  setupMotivationalQuote() {
    const quoteElement = document.getElementById('motivational-quote');
    const totalQuotes = 40;
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
    
    if (this.addWhitelistRuleButton) {
      this.addWhitelistRuleButton.addEventListener('click', () => {
        this.createRuleInputs('', '', null, false, 'whitelist', null, true);
      });
    }
    
    this.scrollToTopBtn.addEventListener('click', () => scrollToTop());
  }
  
  updateWhitelistButtonState() {
    if (!this.addWhitelistRuleButton) return;
    const hasAccess = this.isPro || this.isLegacyUser;
    
    this.addWhitelistRuleButton.disabled = !hasAccess;
    this.addWhitelistRuleButton.title = hasAccess ?
      (t('addwhitelistrule') || 'Add Whitelist Rule') :
      (t('prorequired') || 'Pro mode required');
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
        this.createRuleInputs(
          rule.blockURL,
          rule.redirectURL,
          rule.id,
          rule.disabledByUser ?? false,
          rule.category,
          rule.schedule,
          rule.isWhitelist ?? false
        );
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
  
  createRuleInputs(blockURLValue = '', redirectURLValue = '', ruleId = null, disabledByUser = false, category = 'uncategorized', schedule = null, isWhitelist = false) {
    const ruleDiv = document.createElement('div');
    const isMuted = (this.settings.disabledCategories || []).includes(category);
    
    let className = isMuted ? 'rule category-muted' : 'rule';
    if (isWhitelist) {
      className += ' rule-whitelist';
    }
    ruleDiv.className = className;
    ruleDiv.dataset.ruleId = ruleId;
    ruleDiv.dataset.isWhitelist = isWhitelist;
    
    if (isMuted) {
      ruleDiv.title = t('category_muted_no_edit');
    }
    
    const blockURL = document.createElement('input');
    blockURL.type = 'text';
    blockURL.placeholder = t('blockurl');
    blockURL.value = blockURLValue;
    
    requestAnimationFrame(() => blockURL.focus());
    
    const redirectURL = document.createElement('input');
    redirectURL.type = 'text';
    
    if (isWhitelist) {
      redirectURL.placeholder = 'N/A';
      redirectURL.value = '';
      redirectURL.disabled = true;
      redirectURL.classList.add('input-disabled');
    } else {
      redirectURL.placeholder = t('redirecturl');
      redirectURL.value = redirectURLValue;
    }
    
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
          const saveButton = this.createSaveButton(blockURL, redirectURL, ruleDiv, isWhitelist);
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
        
        if (isWhitelist) {
          const staticDash = document.createElement('span');
          staticDash.className = 'status-static-popup';
          staticDash.textContent = t('status_allow') || 'Allow';
          staticDash.title = t('status_allow');
          ruleDiv.appendChild(staticDash);
        } else if (schedule) {
          const scheduleElement = document.createElement('span');
          scheduleElement.className = 'rule-schedule-popup';
          scheduleElement.textContent = this.scheduleFormatter.formatSchedule(schedule);
          scheduleElement.title = t('rule_scheduled') || 'Scheduled rule';
          ruleDiv.appendChild(scheduleElement);
        } else {
          const toggleElement = document.createElement('span');
          toggleElement.className = 'rule-toggle-popup';
          toggleElement.textContent = disabledByUser ? '✗' : '✓';
          toggleElement.title = disabledByUser ? t('rule_disabled') || 'Disabled' : t('rule_enabled') || 'Enabled';
          toggleElement.style.cursor = 'pointer';
          toggleElement.style.marginLeft = '10px';
          toggleElement.addEventListener('click', async () => {
            if (isMuted) return;
            try {
              const rules = await this.rulesManager.getRules();
              const index = rules.findIndex(r => r.id === ruleId);
              if (index !== -1) {
                await this.rulesManager.toggleRuleDisabled(index);
                await this.loadRules();
                toggleElement.textContent = toggleElement.textContent === '✓' ? '✗' : '✓';
                toggleElement.title = toggleElement.title === (t('rule_enabled') || 'Enabled') ? (t('rule_disabled') || 'Disabled') : (t('rule_enabled') || 'Enabled');
              }
            } catch (error) {
              this.logger.error('Toggle rule error:', error);
            }
          });
          ruleDiv.appendChild(toggleElement);
        }
      }
      
      if (blockURLValue || (showButtons && !blockURLValue)) {
        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete-btn';
        deleteButton.textContent = t('deletebtn');
        
        deleteButton.addEventListener('click', async () => {
          if (isMuted) return;
          await this.handleRuleDeletion(deleteButton, blockURL.value, redirectURL.value, ruleDiv);
        });
        
        ruleDiv.appendChild(deleteButton);
      }
      
      this.rulesContainer.insertAdjacentElement('afterbegin', ruleDiv);
    }, 0);
  }
  
  createSaveButton(blockURL, redirectURL, ruleDiv, isWhitelist = false) {
    const saveButton = document.createElement('button');
    saveButton.className = 'save-btn';
    saveButton.textContent = t('savebtn');
    
    saveButton.addEventListener('click', async () => {
      await this.saveNewRule(blockURL, redirectURL, ruleDiv, saveButton, isWhitelist);
    });
    
    return saveButton;
  }
  
  async initFocusSession() {
    this.startFocusBtn.addEventListener('click', () => this.startFocusSession());
    this.stopFocusBtn.addEventListener('click', () => this.stopFocusSession());
    await this.updateFocusUI();
  }
  
  toggleUIAccessibility(locked) {
    const elementsToLock = [
      document.querySelector('.controls'),
      this.rulesContainer
    ];
    
    elementsToLock.forEach(el => {
      if (el) {
        el.classList.toggle('focus-lock-active', locked);
      }
    });
  }
  
  async updateFocusUI() {
    if (this.focusTimerInterval) {
      clearInterval(this.focusTimerInterval);
      this.focusTimerInterval = null;
    }
    
    const { focusActive, focusEndTime, isHardcore, focusMode } = await getFocusSessionState();
    
    if (focusActive && focusEndTime > Date.now()) {
      this.focusStartView.classList.add('hidden');
      this.focusActiveView.classList.remove('hidden');
      this.toggleUIAccessibility(true);
      
      this.stopFocusBtn.classList.toggle('hidden', isHardcore);
      
      this.updateTimerDisplay(focusEndTime);
      this.focusTimerInterval = setInterval(() => this.updateTimerDisplay(focusEndTime), 1000);
    } else {
      this.focusStartView.classList.remove('hidden');
      this.focusActiveView.classList.add('hidden');
      this.toggleUIAccessibility(false);
      
      if (this.isPro || this.isLegacyUser) {
        this.focusDurationInput.disabled = false;
        this.focusProNote.classList.add('hidden');
        this.hardcoreModeControl.classList.remove('hidden');
        if (this.focusModeControl) {
          this.focusModeControl.classList.remove('hidden');
        }
        if (this.focusModeSelect && focusMode) {
          this.focusModeSelect.value = focusMode;
        }
      } else {
        this.focusDurationInput.disabled = true;
        this.focusDurationInput.value = 25;
        this.focusProNote.classList.remove('hidden');
        this.hardcoreModeControl.classList.add('hidden');
        if (this.focusModeControl) {
          this.focusModeControl.classList.add('hidden');
        }
        if (this.focusModeSelect) {
          this.focusModeSelect.value = 'blacklist';
        }
      }
    }
  }
  
  updateTimerDisplay(endTime) {
    const now = Date.now();
    const remaining = endTime - now;
    
    if (remaining <= 0) {
      this.focusTimerDisplay.textContent = '00:00';
      clearInterval(this.focusTimerInterval);
      this.focusTimerInterval = null;
      this.toggleUIAccessibility(false);
      setTimeout(() => this.updateFocusUI(), 1000);
      return;
    }
    
    const minutes = Math.floor((remaining / 1000 / 60) % 60).toString().padStart(2, '0');
    const seconds = Math.floor((remaining / 1000) % 60).toString().padStart(2, '0');
    this.focusTimerDisplay.textContent = `${minutes}:${seconds}`;
  }
  
  async startFocusSession() {
    const duration = parseInt(this.focusDurationInput.value, 10);
    if (isNaN(duration) || duration < 1 || duration > 240) {
      customAlert(t('focussessioninvalidduration'));
      return;
    }
    
    const hasProAccess = this.isPro || this.isLegacyUser;
    const isHardcore = hasProAccess && this.hardcoreModeCheckbox.checked;
    const focusMode = hasProAccess && this.focusModeSelect ? this.focusModeSelect.value : 'blacklist';
    
    await browser.runtime.sendMessage({
      type: 'start_focus_session',
      duration,
      isHardcore,
      focusMode
    });
    
    await this.updateFocusUI();
  }
  
  async stopFocusSession() {
    await browser.runtime.sendMessage({ type: 'stop_focus_session' });
    await this.updateFocusUI();
  }
  
  async saveNewRule(blockURL, redirectURL, ruleDiv, saveButton, isWhitelist = false) {
    try {
      if (!isWhitelist && !this.isPro && !this.isLegacyUser) {
        const currentRules = await this.rulesManager.getRules();
        if (currentRules.length >= MAX_RULES_LIMIT) {
          customAlert(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
      
      const rules = await this.rulesManager.getRules();
      const ruleExists = this.rulesManager.ruleExists(rules, blockURL.value, redirectURL.value, -1, isWhitelist);
      
      if (ruleExists) {
        customAlert(t('alertruleexist'));
        blockURL.value = '';
        redirectURL.value = '';
        return;
      }
      
      await this.rulesManager.addRule(
        blockURL.value,
        isWhitelist ? '' : redirectURL.value,
        null,
        isWhitelist ? 'whitelist' : 'social',
        isWhitelist
      );
      await this.loadRules();
      
      ruleDiv.remove();
      
      customAlert('+ 1');
      
      if (!isWhitelist) {
        browser.runtime.sendMessage({
          type: 'CLOSE_MATCHING_TABS',
          url: blockURL.value.trim()
        });
      }
    } catch (error) {
      this.logger.error("Save new rule error:", error);
      
      if (error.message.includes('Validation failed')) {
        const errors = error.message.replace('Validation failed: ', '').split(', ');
        this.rulesUI.showValidationErrors(errors);
      } else if (error.message === 'Rule already exists') {
        customAlert(t('alertruleexist'));
        blockURL.value = '';
        redirectURL.value = '';
      } else if (error.message === 'conflict_blacklist') {
        customAlert(t('conflict_blacklist_err') || 'This site is already in your Blacklist. Remove it first.');
      } else if (error.message === 'conflict_whitelist') {
        customAlert(t('conflict_whitelist_err') || 'This site is already in your Whitelist. Remove it first.');
      } else if (error.message === 'redundant_whitelist') {
        customAlert(t('redundant_whitelist_err') || 'This rule is already covered by another whitelist rule.');
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
      const isWhitelist = ruleDiv.dataset.isWhitelist === 'true';
      
      this.rulesUI.handleRuleDeletion(
        deleteButton,
        async () => {
            try {
              if (blockURL) {
                await this.rulesManager.deleteRuleByData(blockURL, redirectURL, isWhitelist);
                await this.loadRules();
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
    
    if (this.focusSection) {
      this.focusSection.classList.toggle('hidden', count === 0);
    }
  }
  
  cleanup() {
    this.rulesUI.cleanup();
    if (this.focusTimerInterval) {
      clearInterval(this.focusTimerInterval);
    }
  }
}

const popupPage = new PopupPage();

window.addEventListener('beforeunload', () => {
  popupPage.cleanup();
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'reload_rules') {
    popupPage.loadRules();
  }
  
  if (message.type === 'pro_status_changed') {
    logger.log(`Pro status changed: ${message.isPro}`);
    
    ProManager.updateProFeaturesVisibility(message.isPro);
    popupPage.isPro = message.isPro;
    popupPage.updateWhitelistButtonState();
    popupPage.loadRules();
    
    sendResponse({ received: true });
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initializeNoSpaceInputs();
  
  setTimeout(() => {
    window.scrollTo({
      top: 0,
      left: 0,
      behavior: 'instant'
    });
    
    document.body.classList.add('ready')
  }, 75);
});
