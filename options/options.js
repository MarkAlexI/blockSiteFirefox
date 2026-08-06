import { t } from '../scripts/t.js';
import { SettingsManager } from './settings.js';
import { ProManager } from '../pro/proManager.js';
import { RulesManager } from '../rules/rulesManager.js';
import { RulesClient } from '../rules/rulesClient.js';
import { RulesUI } from '../rules/rulesUI.js';
import { CategoryManager } from '../rules/categoryManager.js';
import { CategoryUIManager } from './categoryUIManager.js';
import { PasswordUtils } from '../pro/password.js';
import { initializeNoSpaceInputs } from '../utils/noSpaces.js';
import Logger from '../utils/logger.js';
import { MAX_RULES_LIMIT } from '../utils/constants.js';
import { checkDNR } from '../utils/dnrDebug.js';
import { initFeedbackPopup } from './feedback.js';
import { isVisibleRuleGroupEnd } from '../rules/visibleRuleGrouping.js';
import { RulePacksUI } from './rulePacksUI.js';

const logger = new Logger('OptionsPage');

class OptionsPage {
  constructor() {
    this.logger = logger;
    this.settingsManager = new SettingsManager();
    this.rulesManager = new RulesManager();
    this.rulesClient = new RulesClient();
    this.rulesUI = new RulesUI();
    
    this.rulesBody = document.getElementById('rules-container');
    this.addRuleButton = document.getElementById('add-rule');
    this.addWhitelistRuleButton = document.getElementById('add-whitelist-rule');
    this.statusElement = document.getElementById('status');
    this.searchInput = document.getElementById('search-input');
    this.categoryFilter = document.getElementById('category-filter');
    this.categoriesContainer = document.getElementById('categories-container');
    this.rulePacksUI = new RulePacksUI({
      dialog: document.getElementById('rule-packs-dialog'),
      openButton: document.getElementById('open-rule-packs'),
      closeButton: document.getElementById('rule-packs-close'),
      cancelButton: document.getElementById('rule-packs-cancel'),
      addButton: document.getElementById('rule-packs-add'),
      packSelect: document.getElementById('rule-packs-select'),
      description: document.getElementById('rule-packs-description'),
      category: document.getElementById('rule-packs-category'),
      selectAll: document.getElementById('rule-packs-select-all'),
      entriesContainer: document.getElementById('rule-packs-entries'),
      status: document.getElementById('rule-packs-status'),
      onAdd: (packId, entryIds) => this.addRulePack(packId, entryIds)
    });
    
    this.isPro = false;
    this.isLegacyUser = false;
    
    this.init();
    this.exposeDebugTools();
  }
  
  exposeDebugTools() {
    window.checkDNR = checkDNR;
  }
  
  async init() {
    this.initializeUI();
    this.setupEventListeners();
    this.rulePacksUI.initialize();
    try {
      this.isPro = await ProManager.isPro();
      this.isLegacyUser = await ProManager.isLegacyUser();
    } catch (error) {
      this.logger.error('Error initializing Pro/Legacy status:', error);
    }
    
    this.updateWhitelistButtonState();
    
    await ProManager.initializeProFeatures();
    this.loadRules();
    this.loadCategories();
  }
  
  initializeUI() {
    const setContent = (id, key) => {
      const el = document.getElementById(id);
      if (el) el.textContent = t(key);
    };
    
    setContent('options-title', 'header');
    setContent('header-text', 'header');
    if (this.addRuleButton) this.addRuleButton.textContent = t('addrule');
    if (this.addWhitelistRuleButton) this.addWhitelistRuleButton.textContent = t('addwhitelistrule') || 'Add Whitelist Rule';
    setContent('block-url-header', 'blockurl');
    setContent('redirect-url-header', 'redirecturlheader');
    setContent('category-header', 'category_header');
    setContent('actions-header', 'actionsheader');
    
    if (this.categoryFilter) {
      this.categoryFilter.title = t('filter_only_hint') || 'This dropdown only filters the list below';
    }
    if (this.searchInput) this.searchInput.placeholder = t('searchfordomain');
    
    const translateOption = (val, key) => {
      const opt = this.categoryFilter.querySelector(`option[value="${val}"]`);
      if (opt) opt.textContent = t(key);
    };
    
    translateOption('all', 'allcategories');
    translateOption('social', 'category_social');
    translateOption('news', 'category_news');
    translateOption('entertainment', 'category_entertainment');
    translateOption('shopping', 'category_shopping');
    translateOption('work', 'category_work');
    translateOption('gaming', 'category_gaming');
    translateOption('adult', 'category_adult');
    translateOption('whitelist', 'category_whitelist');
    translateOption('uncategorized', 'category_uncategorized');
  }
  
  setupEventListeners() {
    if (this.addRuleButton) this.addRuleButton.addEventListener('click', () => this.showAddRuleForm(false));
    if (this.addWhitelistRuleButton) this.addWhitelistRuleButton.addEventListener('click', () => this.showAddRuleForm(true));
    if (this.searchInput) this.searchInput.addEventListener('input', () => this.loadRules());
    if (this.categoryFilter) this.categoryFilter.addEventListener('change', () => this.loadRules());
    
    document.querySelectorAll('.collapsible-header').forEach(header => {
      header.addEventListener('click', () => header.parentElement.classList.toggle('expanded'));
    });
  }
  
  updateWhitelistButtonState() {
    if (!this.addWhitelistRuleButton) return;
    const hasAccess = this.isPro || this.isLegacyUser;
    
    this.addWhitelistRuleButton.disabled = !hasAccess;
    this.addWhitelistRuleButton.title = hasAccess ?
      (t('addwhitelistrule') || 'Add Whitelist Rule') :
      (t('prorequired') || 'Pro mode required');
  }
  
  async promptForPassword() {
    return new Promise((resolve) => {
      PasswordUtils.showPasswordModal('verify', (isValid) => {
        resolve(isValid);
      }, t);
    });
  }

  handleRulesMutationError(error, fallbackKey = 'errorupdatingrules') {
    if (error.code === 'validation_failed') {
      this.rulesUI.showValidationErrors(error.validationErrors || []);
    } else if (error.code === 'rule_already_exists') {
      this.rulesUI.showErrorMessage(t('alertruleexist'));
    } else if (error.code === 'conflict_blacklist') {
      this.rulesUI.showErrorMessage(t('conflict_blacklist_err') || 'This site is already in your Blacklist. Remove it first.');
    } else if (error.code === 'conflict_whitelist') {
      this.rulesUI.showErrorMessage(t('conflict_whitelist_err') || 'This site is already in your Whitelist. Remove it first.');
    } else if (error.code === 'redundant_whitelist') {
      this.rulesUI.showErrorMessage(t('redundant_whitelist_err') || 'This rule is already covered by another whitelist rule.');
    } else if (error.code === 'rule_limit_reached') {
      this.rulesUI.showErrorMessage(t('rulelimitreached', MAX_RULES_LIMIT));
    } else if (error.code === 'pro_required') {
      this.rulesUI.showErrorMessage(t('prorequired'));
    } else {
      this.rulesUI.showErrorMessage(t(fallbackKey));
    }
  }
  
  async loadRules(rules_from_message = null) {
    try {
      let rules;
      
      if (Array.isArray(rules_from_message)) {
        rules = rules_from_message;
        this.logger.log("Options: Loading rules from message.");
      } else {
        this.logger.log("Options: Fetching rules from storage.");
        rules = await this.rulesManager.getRules();
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
      const settings = await SettingsManager.getSettings();
      const disabledCategories = settings.disabledCategories || [];
      this.renderRules(filteredRules, canEdit, isFiltered, disabledCategories);
      this.rulesUI.updateStatus(this.statusElement, filteredRules.length);
      
      if (this.settingsManager) {
        this.settingsManager.loadRuleCount(rules);
      }
      
    } catch (error) {
      this.logger.error("Load rules error:", error);
      this.rulesUI.showErrorMessage(t('errorupdatingrules'));
    }
  }
  
  renderRules(rules, canEdit, isFiltered = false, disabledCategories = []) {
    this.rulesBody.innerHTML = '';
    const noRulesMessage = isFiltered ? t('norulesforcategory') : t('norules');
    
    if (rules.length === 0) {
      const emptyRow = this.rulesUI.createEmptyRow(noRulesMessage, 5);
      this.rulesBody.appendChild(emptyRow);
      return;
    }
    
    const displayedRules = [...rules].reverse();

    displayedRules.forEach((rule, displayIndex) => {
      const row = this.createRuleRow(rule, displayIndex, canEdit, disabledCategories);

      if (isVisibleRuleGroupEnd(displayIndex, displayedRules.length)) {
        row.classList.add('rule-group-end');
      }

      this.rulesBody.appendChild(row);
    });
  }
  
  createRuleRow(rule, index, canEdit, disabledCategories = []) {
    const isMuted = disabledCategories.includes(rule.category);
    const row = this.rulesUI.createRuleDisplayRow(
      rule,
      index,
      (row, ruleId, rule) => this.toggleEditMode(row, ruleId, rule),
      (e, ruleId) => this.handleRuleDeletion(e, ruleId),
      async (ruleId) => {
          if (isMuted) return;
          try {
            await this.rulesClient.toggleRule(ruleId);
          } catch (error) {
            this.logger.error('Toggle rule error:', error);
            this.handleRulesMutationError(error, 'errorupdatingrules');
          }
        },
        canEdit,
        disabledCategories
    );
    if (isMuted) {
      row.title = t('category_muted_no_edit');
    }
    return row;
  }
  
  async handleRuleDeletion(event, ruleId) {
    try {
      const settingsForMode = await SettingsManager.getSettings();
      const isStrictMode = settingsForMode.mode === 'strict';
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
              await this.rulesClient.deleteRule(ruleId);
              this.rulesUI.showSuccessMessage(t('ruleddeleted'), this.statusElement);
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
  
  async toggleEditMode(row, ruleId, rule) {
    const settings = await SettingsManager.getSettings();
    const disabledCategories = settings.disabledCategories || [];
    const isWhitelist = rule.isWhitelist || false;
    
    if (!isWhitelist && disabledCategories.includes(rule.category)) {
      this.rulesUI.showErrorMessage(t('category_muted_no_edit') || 'Cannot edit: Category blocking is paused');
      return;
    }
    const editRow = this.rulesUI.createRuleEditRow(
      rule,
      ruleId,
      (ruleId, blockValue, redirectValue, category, schedule) => this.saveEditedRule(ruleId, blockValue, redirectValue, category, schedule, rule.disabledByUser, isWhitelist),
      () => this.loadRules(),
      this.isPro,
      rule.disabledByUser
    );

    if (row.classList.contains('rule-group-end')) {
      editRow.classList.add('rule-group-end');
    }
    
    if (settings.enablePassword) {
      const isValid = await this.promptForPassword();
      if (!isValid) return;
    }
    
    row.replaceWith(editRow);
  }
  
  async saveEditedRule(ruleId, newBlock, newRedirect, newCategory, newSchedule, disabledByUser, isWhitelist = false) {
    try {
      await this.rulesClient.updateRule({
        ruleId,
        blockURL: newBlock,
        redirectURL: isWhitelist ? '' : newRedirect,
        schedule: newSchedule,
        category: isWhitelist ? 'whitelist' : newCategory,
        disabledByUser
      });
      
      this.statusElement.textContent = t('ruleupdated');
    } catch (error) {
      this.logger.info("Save edited rule error:", error);
      this.handleRulesMutationError(error, 'errorupdatingrules');
    }
  }
  
  async showAddRuleForm(isWhitelist = false) {
    try {
      if (!isWhitelist && !this.isPro && !this.isLegacyUser) {
        const rules = await this.rulesManager.getRules();
        if (rules.length >= MAX_RULES_LIMIT) {
          this.rulesUI.showErrorMessage(t('rulelimitreached', MAX_RULES_LIMIT));
          return;
        }
      }
      
      const newRow = this.rulesUI.createAddRuleRow(
        (blockValue, redirectValue, category, schedule, row) => this.saveNewRule(blockValue, redirectValue, category, schedule, row, isWhitelist),
        (row) => row.remove(),
        this.isPro,
        isWhitelist
      );
      
      this.rulesBody.insertBefore(newRow, this.rulesBody.firstChild);
    } catch (error) {
      this.logger.info('Error checking rule limit:', error);
      this.rulesUI.showErrorMessage(t('erroraddingrule'));
    }
  }
  
  async saveNewRule(newBlock, newRedirect, newCategory, newSchedule, row, isWhitelist = false) {
    try {
      await this.rulesClient.addRule({
        blockURL: newBlock,
        redirectURL: isWhitelist ? '' : newRedirect,
        schedule: newSchedule,
        category: isWhitelist ? 'whitelist' : newCategory,
        isWhitelist
      });
      
      this.statusElement.textContent = t('rulenewadded');
    } catch (error) {
      this.logger.info("Save new rule error:", error);
      this.handleRulesMutationError(error, 'errorupdatingrules');
    }
  }
  
  async addRulePack(packId, entryIds) {
    try {
      return await this.rulesClient.addMany(packId, entryIds);
    } catch (error) {
      this.logger.error('Add rule pack error:', error);
      this.handleRulesMutationError(error, 'rulepacks_error');
      throw error;
    }
  }
  
  async loadCategories() {
    try {
      const rules = await this.rulesManager.getRules();
      const settings = await SettingsManager.getSettings();
      const disabledCategories = settings.disabledCategories || [];
      if (!this.categoriesContainer) return;
      CategoryUIManager.updateCategoryGrid(
        this.categoriesContainer,
        rules,
        disabledCategories,
        (category) => this.handleCategoryToggle(category)
      );
    } catch (error) {
      this.logger.error('Load categories error:', error);
    }
  }
  
  async handleCategoryToggle(category) {
    try {
      if (!this.isPro && !this.isLegacyUser) {
        this.rulesUI.showErrorMessage(t('prorequired'));
        this.loadCategories();
        return;
      }
      await this.rulesClient.toggleCategory(category);
    } catch (error) {
      this.logger.error('Category toggle error:', error);
      this.rulesUI.showErrorMessage(t('errorupdatingrules'));
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
  if (message.type === 'rules:changed') {
    logger.log('Rules changed');
    if (message.migrated) {
      optionsPage.rulesUI.showAlert(t('rulesmigrated'));
    }
    optionsPage.loadRules(message.rules);
    optionsPage.loadCategories();
    if (optionsPage.settingsManager) {
      optionsPage.settingsManager.loadRuleCount(message.rules);
    }
  }
  
  if (message.type === 'pro_status_changed') {
    logger.log(`Pro status changed: ${message.isPro}`);
    ProManager.updateProFeaturesVisibility(message.isPro);
    optionsPage.isPro = message.isPro;
    optionsPage.updateWhitelistButtonState();
    optionsPage.loadRules();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initializeNoSpaceInputs();
  initFeedbackPopup();
});