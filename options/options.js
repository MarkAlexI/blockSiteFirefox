import { t } from '../scripts/t.js';
import { SettingsManager } from './settings.js';
import { ProManager } from '../pro/proManager.js';
import { RulesManager } from '../rules/rulesManager.js';
import { RulesUI } from '../rules/rulesUI.js';
import { PasswordUtils } from '../pro/password.js';
import { initializeNoSpaceInputs } from '../utils/noSpaces.js';
import Logger from '../utils/logger.js';

const MAX_RULES_LIMIT = 5;
const logger = new Logger('OptionsPage');

class OptionsPage {
  constructor() {
    this.logger = logger;
    this.settingsManager = new SettingsManager();
    this.rulesManager = new RulesManager();
    this.rulesUI = new RulesUI();
    
    this.rulesBody = document.getElementById('rules-container');
    this.addRuleButton = document.getElementById('add-rule');
    this.statusElement = document.getElementById('status');
    this.searchInput = document.getElementById('search-input');
    this.categoryFilter = document.getElementById('category-filter');

    this.init();
  }
  
  async init() {
    this.initializeUI();
    this.setupEventListeners();
    this.settingsManager.setRulesUpdatedCallback(() => {
      this.loadRules();
    });
    
    try {
      this.isPro = await ProManager.isPro();
      this.isLegacyUser = await ProManager.isLegacyUser();
    } catch (error) {
      this.logger.error('Error initializing Pro/Legacy status:', error);
    }
    
    await ProManager.initializeProFeatures();
    this.loadRules();
  }
  
  initializeUI() {
    const setContent = (id, key) => {
      const el = document.getElementById(id);
      if (el) el.textContent = t(key);
    };

    setContent('options-title', 'header');
    setContent('header-text', 'header');
    if(this.addRuleButton) this.addRuleButton.textContent = t('addrule');
    setContent('block-url-header', 'blockurl');
    setContent('redirect-url-header', 'redirecturl');
    setContent('category-header', 'category_header');
    setContent('actions-header', 'actionsheader');
    
    if(this.searchInput) this.searchInput.placeholder = t('searchfordomain');

    const translateOption = (val, key) => {
        const opt = this.categoryFilter.querySelector(`option[value="${val}"]`);
        if(opt) opt.textContent = t(key);
    };

    translateOption('all', 'allcategories');
    translateOption('social', 'category_social');
    translateOption('news', 'category_news');
    translateOption('entertainment', 'category_entertainment');
    translateOption('shopping', 'category_shopping');
    translateOption('work', 'category_work');
    translateOption('gaming', 'category_gaming');
    translateOption('adult', 'category_adult');
    translateOption('uncategorized', 'category_uncategorized');
  }
  
  setupEventListeners() {
    if(this.addRuleButton) this.addRuleButton.addEventListener('click', () => this.showAddRuleForm());
    if(this.searchInput) this.searchInput.addEventListener('input', () => this.loadRules());
    if(this.categoryFilter) this.categoryFilter.addEventListener('change', () => this.loadRules());
  }

  async promptForPassword() {
    return new Promise((resolve) => {
      PasswordUtils.showPasswordModal('verify', (isValid) => {
        resolve(isValid);
      }, t);
    });
  }
  
  async loadRules(rules_from_message = null) {
    try {
      let rules;
      let migrationResult = { migrated: false };
      
      if (rules_from_message) {
        rules = rules_from_message;
        this.logger.log("Options: Loading rules from message.");
      } else {
        this.logger.log("Options: Fetching rules from storage.");
        migrationResult = await this.rulesManager.migrateRules();
        rules = migrationResult.rules || await this.rulesManager.getRules();
      }
      
      if (migrationResult.migrated && !rules_from_message) {
        this.rulesUI.showAlert(t('rulesmigrated'));
      }
      
      let filteredRules = rules;
      let isFiltered = false;
      
      const searchTerm = this.searchInput.value.trim().toLowerCase();
      if (searchTerm) {
        filteredRules = filteredRules.filter(rule => rule.blockURL.toLowerCase().includes(searchTerm));
        isFiltered = true;
      }
      
      const selectedCategory = this.categoryFilter.value;
      if (selectedCategory !== 'all') {
        filteredRules = filteredRules.filter(rule => rule.category === selectedCategory);
        isFiltered = true;
      }
      
      const canEdit = this.isPro || this.isLegacyUser || rules.length <= MAX_RULES_LIMIT;
      this.renderRules(filteredRules, canEdit, isFiltered);
      this.rulesUI.updateStatus(this.statusElement, filteredRules.length);
      
      if (this.settingsManager) {
        this.settingsManager.loadRuleCount(rules);
      }
      
    } catch (error) {
      this.logger.error("Load rules error:", error);
      this.rulesUI.showErrorMessage(t('errorupdatingrules'));
    }
  }
  
  renderRules(rules, canEdit, isFiltered = false) {
    this.rulesBody.innerHTML = '';
    const noRulesMessage = isFiltered ? t('norulesforcategory') : t('norules');
    
    if (rules.length === 0) {
      const emptyRow = this.rulesUI.createEmptyRow(noRulesMessage, 5);
      this.rulesBody.appendChild(emptyRow);
      return;
    }
    
    rules.forEach((rule, index) => {
      const row = this.createRuleRow(rule, index, canEdit);
      this.rulesBody.prepend(row);
    });
  }
  
  createRuleRow(rule, index, canEdit) {
    return this.rulesUI.createRuleDisplayRow(
      rule,
      index,
      (row, index, rule) => this.toggleEditMode(row, index, rule),
      (e, index) => this.handleRuleDeletion(e, index),
      canEdit
    );
  }
  
  async handleRuleDeletion(event, index) {
    try {
      const isStrictMode = await this.rulesManager.isStrictMode();
      const deleteButton = event.target;

      const settings = await SettingsManager.getSettings();
      if (settings.enablePassword) {
        const isValid = await this.promptForPassword();
        if (!isValid) return;
      }
      
      this.rulesUI.handleRuleDeletion(
        deleteButton,
        async () => {
            try {
              await this.rulesManager.deleteRule(index);
              this.rulesUI.showSuccessMessage(t('ruleddeleted'), this.statusElement);
              this.loadRules();
            } catch (error) {
              this.logger.error("Delete rule error:", error);
              this.rulesUI.showErrorMessage(t('errorremovingrule'));
            }
          },
          isStrictMode,
          t('deletebtn')
      );
    } catch (error) {
      this.logger.error("Handle deletion error:", error);
      this.rulesUI.showErrorMessage(t('errorremovingrule'));
    }
  }
  
  async toggleEditMode(row, index, rule) {
    const editRow = this.rulesUI.createRuleEditRow(
      rule,
      index,
      (index, blockValue, redirectValue, category, schedule, ruleId) => this.saveEditedRule(index, blockValue, redirectValue, category, schedule, ruleId),
      () => this.loadRules(),
      this.isPro
    );
    
    const settings = await SettingsManager.getSettings();
    if (settings.enablePassword) {
      const isValid = await this.promptForPassword();
      if (!isValid) return;
    }
    
    row.replaceWith(editRow);
  }
  
  async saveEditedRule(index, newBlock, newRedirect, newCategory, newSchedule, oldRuleId) {
    try {
      await this.rulesManager.updateRule(index, newBlock, newRedirect, newSchedule, newCategory);
      
      if (newBlock) {
        browser.runtime.sendMessage({
          type: 'CLOSE_MATCHING_TABS',
          url: newBlock.trim()
        });
      }
      
      this.statusElement.textContent = t('ruleupdated');
      this.loadRules();
    } catch (error) {
      this.logger.info("Save edited rule error:", error);
      if (error.message.includes('Validation failed')) {
        const errors = error.message.replace('Validation failed: ', '').split(', ');
        this.rulesUI.showValidationErrors(errors);
      } else if (error.message === 'Rule already exists') {
        this.rulesUI.showErrorMessage(t('alertruleexist'));
      } else {
        this.rulesUI.showErrorMessage(t('errorupdatingrule'));
      }
    }
  }
  
  async showAddRuleForm() {
    try {
      if (!this.isPro && !this.isLegacyUser) {
        const rules = await this.rulesManager.getRules();
        if (rules.length >= MAX_RULES_LIMIT) {
          this.rulesUI.showErrorMessage(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
      
      const newRow = this.rulesUI.createAddRuleRow(
        (blockValue, redirectValue, category, schedule, row) => this.saveNewRule(blockValue, redirectValue, category, schedule, row),
        (row) => row.remove(),
        this.isPro
      );
      
      this.rulesBody.insertBefore(newRow, this.rulesBody.firstChild);
    } catch (error) {
      this.logger.info('Error checking rule limit:', error);
      this.rulesUI.showErrorMessage(t('erroraddingrule'));
    }
  }
  
  async saveNewRule(newBlock, newRedirect, newCategory, newSchedule, row) {
    try {
      await this.rulesManager.addRule(newBlock, newRedirect, newSchedule, newCategory);
      
      if (newBlock) {
        browser.runtime.sendMessage({
          type: 'CLOSE_MATCHING_TABS',
          url: newBlock.trim()
        });
      }
      
      this.statusElement.textContent = t('rulenewadded');
      this.loadRules();
    } catch (error) {
      this.logger.info("Save new rule error:", error);
      if (error.message.includes('Validation failed')) {
        const errors = error.message.replace('Validation failed: ', '').split(', ');
        this.rulesUI.showValidationErrors(errors);
      } else if (error.message === 'Rule already exists') {
        this.rulesUI.showErrorMessage(t('alertruleexist'));
      } else {
        this.rulesUI.showErrorMessage(t('errorupdatingrule'));
      }
    }
  }
  
  cleanup() {
    this.rulesUI.cleanup();
  }
}

const optionsPage = new OptionsPage();

window.addEventListener('beforeunload', () => {
  optionsPage.cleanup();
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'reload_rules') {
    logger.log('Reload rules');
    optionsPage.loadRules(message.rules);
    if (optionsPage.settingsManager) {
      optionsPage.settingsManager.loadRuleCount(message.rules);
    }
  }
  
  if (message.type === 'pro_status_changed') {
    logger.log(`Pro status changed: ${message.isPro}`);
    ProManager.updateProFeaturesVisibility(message.isPro);
    optionsPage.isPro = message.isPro;
    optionsPage.loadRules();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initializeNoSpaceInputs();
});