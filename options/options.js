import { t } from '../scripts/t.js';
import { SettingsManager } from './settings.js';
import { ProManager } from '../pro/proManager.js';
import { RulesManager } from '../rules/rulesManager.js';
import { RulesUI } from '../rules/rulesUI.js';

const MAX_RULES_LIMIT = 5;

class OptionsPage {
  constructor() {
    this.settingsManager = new SettingsManager();
    this.rulesManager = new RulesManager();
    this.rulesUI = new RulesUI();
    
    this.rulesBody = document.getElementById('rules-body');
    this.addRuleButton = document.getElementById('add-rule');
    this.statusElement = document.getElementById('status');
    
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
      console.info('Error initializing Pro/Legacy status:', error);
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
    document.getElementById('actions-header').textContent = t('actionsheader') || 'Дії';
  }
  
  setupEventListeners() {
    this.addRuleButton.addEventListener('click', () => this.showAddRuleForm());
  }
  
  async loadRules() {
    try {
      const migrationResult = await this.rulesManager.migrateRules();
      if (migrationResult.migrated) {
        this.rulesUI.showAlert(t('rulesmigrated'));
      }
      
      const rules = migrationResult.rules || await this.rulesManager.getRules();
      this.renderRules(rules);
      this.rulesUI.updateStatus(this.statusElement, rules.length);
    } catch (error) {
      console.error("Load rules error:", error);
      this.rulesUI.showErrorMessage(t('errorupdatingrules'));
    }
  }
  
  renderRules(rules) {
    this.rulesBody.innerHTML = '';
    
    if (rules.length === 0) {
      const emptyRow = this.rulesUI.createEmptyRow(t('norules'), 3);
      this.rulesBody.appendChild(emptyRow);
      return;
    }
    
    rules.forEach((rule, index) => {
      const row = this.createRuleRow(rule, index);
      this.rulesBody.prepend(row);
    });
  }
  
  createRuleRow(rule, index) {
    return this.rulesUI.createRuleDisplayRow(
      rule,
      index,
      (row, index, rule) => this.toggleEditMode(row, index, rule),
      (e, index) => this.handleRuleDeletion(e, index),
      this.isPro || this.isLegacyUser
    );
  }
  
  async handleRuleDeletion(event, index) {
    try {
      const isStrictMode = await this.rulesManager.isStrictMode();
      const deleteButton = event.target;
      
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
  
  toggleEditMode(row, index, rule) {
    const editRow = this.rulesUI.createRuleEditRow(
      rule,
      index,
      (index, blockValue, redirectValue, ruleId) => this.saveEditedRule(index, blockValue, redirectValue, ruleId),
      () => this.loadRules()
    );
    
    row.replaceWith(editRow);
  }
  
  async saveEditedRule(index, newBlock, newRedirect, oldRuleId) {
    try {
      await this.rulesManager.updateRule(index, newBlock, newRedirect);
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
        (blockValue, redirectValue, row) => this.saveNewRule(blockValue, redirectValue, row),
        (row) => row.remove()
      );
      
      this.rulesBody.insertBefore(newRow, this.rulesBody.firstChild);
    } catch (error) {
      console.info('Error checking rule limit:', error);
      this.rulesUI.showErrorMessage(t('erroraddingrule'));
    }
  }
  
  async saveNewRule(newBlock, newRedirect, row) {
    try {
      await this.rulesManager.addRule(newBlock, newRedirect);
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

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'reload_rules') {
    optionsPage.loadRules();
  }
  
  if (message.type === 'pro_status_changed') {
    console.log(`Pro status changed: ${message.isPro}`);
    
    ProManager.updateProFeaturesVisibility(message.isPro);
    
    sendResponse({ received: true });
  }
});