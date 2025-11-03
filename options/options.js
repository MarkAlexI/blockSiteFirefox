import { t } from '../scripts/t.js';
import { SettingsManager } from './settings.js';
import { ProManager } from '../pro/proManager.js';
import { RulesManager } from '../rules/rulesManager.js';
import { RulesUI } from '../rules/rulesUI.js';
import { PasswordUtils } from '../pro/password.js';
import { initializeNoSpaceInputs } from '../utils/noSpaces.js';

const MAX_RULES_LIMIT = 5;

class OptionsPage {
  constructor() {
    this.settingsManager = new SettingsManager();
    this.rulesManager = new RulesManager();
    this.rulesUI = new RulesUI();
    
    this.rulesBody = document.getElementById('rules-container');
    this.addRuleButton = document.getElementById('add-rule');
    this.statusElement = document.getElementById('status');
    this.searchInput = document.getElementById('search-input');
    this.categoryFilter = document.getElementById('category-filter');
    
    this.isPro = false;
    this.isLegacyUser = true;
    
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
      console.error('Error initializing Pro/Legacy status:', error);
    }
    
    await ProManager.initializeProFeatures();
    this.loadRules();
  }
  
  initializeUI() {
    document.getElementById('options-title').textContent = t('header');
    document.getElementById('header-text').textContent = t('header');
    this.addRuleButton.textContent = t('addrule');
    document.getElementById('block-url-header').textContent = t('blockurl');
    document.getElementById('redirect-url-header').textContent = t('redirecturl');
    document.getElementById('category-header').textContent = t('category_header');
    document.getElementById('actions-header').textContent = t('actionsheader');
    this.searchInput.placeholder = t('searchfordomain');
    const allOption = this.categoryFilter.querySelector('option[value="all"]');
    allOption.textContent = t('allcategories');
    const socialOption = this.categoryFilter.querySelector('option[value="social"]');
    socialOption.textContent = t('category_social');
    const newsOption = this.categoryFilter.querySelector('option[value="news"]');
    newsOption.textContent = t('category_news');
    const entertainmentOption = this.categoryFilter.querySelector('option[value="entertainment"]');
    entertainmentOption.textContent = t('category_entertainment');
    const shoppingOption = this.categoryFilter.querySelector('option[value="shopping"]');
    shoppingOption.textContent = t('category_shopping');
    const workOption = this.categoryFilter.querySelector('option[value="work"]');
    workOption.textContent = t('category_work');
    const gamingOption = this.categoryFilter.querySelector('option[value="gaming"]');
    gamingOption.textContent = t('category_gaming');
    const adultOption = this.categoryFilter.querySelector('option[value="adult"]');
    adultOption.textContent = t('category_adult');
    const uncategorizedOption = this.categoryFilter.querySelector('option[value="uncategorized"]');
    uncategorizedOption.textContent = t('category_uncategorized');
  }
  
  setupEventListeners() {
    this.addRuleButton.addEventListener('click', () => this.showAddRuleForm());
    this.searchInput.addEventListener('input', () => this.loadRules());
    this.categoryFilter.addEventListener('change', () => this.loadRules());
  }
  
  async loadRules() {
    try {
      const migrationResult = await this.rulesManager.migrateRules();
      if (migrationResult.migrated) {
        this.rulesUI.showAlert(t('rulesmigrated'));
      }
      
      let rules = migrationResult.rules || await this.rulesManager.getRules();
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
    } catch (error) {
      console.error("Load rules error:", error);
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
        if (!isValid) {
          this.rulesUI.showErrorMessage(t('invalidpassword'));
          return;
        }
      }
      
      this.rulesUI.handleRuleDeletion(
        deleteButton,
        async () => {
            try {
              await this.rulesManager.deleteRule(index);
              this.rulesUI.showSuccessMessage(t('ruleddeleted'), this.statusElement);
              this.loadRules();
            } catch (error) {
              console.error("Delete rule error:", error);
              this.rulesUI.showErrorMessage(t('errorremovingrule'));
            }
          },
          isStrictMode,
          t('deletebtn')
      );
    } catch (error) {
      console.error("Handle deletion error:", error);
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
      if (!isValid) {
        this.rulesUI.showErrorMessage(t('invalidpassword'));
        return;
      }
    }
    
    row.replaceWith(editRow);
  }
  
  async promptForPassword() {
    return new Promise((resolve) => {
      PasswordUtils.showPasswordModal('verify', (isValid) => {
        resolve(isValid);
      }, t);
    });
  }
  
  async saveEditedRule(index, newBlock, newRedirect, newCategory, newSchedule, oldRuleId) {
    console.log('Saving edited rule with schedule:', newSchedule);
    try {
      await this.rulesManager.updateRule(index, newBlock, newRedirect, newSchedule, newCategory);
      this.statusElement.textContent = t('ruleupdated');
      this.loadRules();
    } catch (error) {
      console.info("Save edited rule error:", error);
      
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
      console.info('Error checking rule limit:', error);
      this.rulesUI.showErrorMessage(t('erroraddingrule'));
    }
  }
  
  async saveNewRule(newBlock, newRedirect, newCategory, newSchedule, row) {
    try {
      await this.rulesManager.addRule(newBlock, newRedirect, newSchedule, newCategory);
      this.statusElement.textContent = t('rulenewadded');
      this.loadRules();
    } catch (error) {
      console.info("Save new rule error:", error);
      
      if (error.message.includes('Validation failed')) {
        const errors = error.message.replace('Validation failed: ', '').split(', ');
        this.rulesUI.showValidationErrors(errors);
      } else if (error.message === 'Rule already exists') {
        this.rulesUI.showErrorMessage(t('alertruleexist'));
      } else {
        this.rulesUI.showErrorMessage(t('erroraddingrule'));
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
    optionsPage.loadRules();
  }
  
  if (message.type === 'pro_status_changed') {
    console.log(`Pro status changed: ${message.isPro}`);
    
    ProManager.updateProFeaturesVisibility(message.isPro);
    
    optionsPage.isPro = message.isPro;
    optionsPage.loadRules();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initializeNoSpaceInputs();
});