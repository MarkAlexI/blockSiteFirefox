import { t } from '../scripts/t.js';
import { SettingsManager } from './settings.js';
import { ProManager } from '../pro/proManager.js';
import { RulesManager } from '../rules/rulesManager.js';
import { RulesClient, sendRuntimeMessage } from '../rules/rulesClient.js';
import { RulesUI } from '../rules/rulesUI.js';
import { CategoryManager } from '../rules/categoryManager.js';
import { CategoryUIManager } from './categoryUIManager.js';
import { RuleListsManager, GENERAL_RULE_LIST_ID } from '../rules/ruleListsManager.js';
import { isRuleInList, isRuleListMembershipActive } from '../rules/ruleListMembership.js';
import { DailyLimitManager } from '../rules/dailyLimitManager.js';
import { RuleListsUI, resolveRuleListContext } from './ruleListsUI.js';
import { PasswordUtils } from '../pro/password.js';
import { initializeNoSpaceInputs } from '../utils/noSpaces.js';
import Logger from '../utils/logger.js';
import { MAX_RULES_LIMIT } from '../utils/constants.js';
import { checkDNR } from '../utils/dnrDebug.js';
import { isVisibleRuleGroupEnd } from '../rules/visibleRuleGrouping.js';
import { RulePacksUI } from './rulePacksUI.js';
import { DiagnosticsUI } from './diagnosticsUI.js';
import { installPageErrorReporter } from '../telemetry/pageErrorReporter.js';
import { TelemetryUI } from './telemetryUI.js';
import { requestTelemetryConsentFromUserAction } from '../telemetry/telemetryConsent.js';

installPageErrorReporter('options');

const logger = new Logger('OptionsPage');

class OptionsPage {
  constructor() {
    this.logger = logger;
    this.settingsManager = new SettingsManager();
    this.rulesManager = new RulesManager();
    this.ruleListsManager = new RuleListsManager();
    this.dailyLimitManager = new DailyLimitManager();
    this.rulesClient = new RulesClient();
    this.rulesUI = new RulesUI();
    
    this.rulesBody = document.getElementById('rules-container');
    this.addRuleButton = document.getElementById('add-rule');
    this.addWhitelistRuleButton = document.getElementById('add-whitelist-rule');
    this.statusElement = document.getElementById('status');
    this.searchInput = document.getElementById('search-input');
    this.categoryFilter = document.getElementById('category-filter');
    this.ruleListFilter = document.getElementById('rule-list-filter');
    this.categoriesContainer = document.getElementById('categories-container');
    this.ruleListsContainer = document.getElementById('rule-lists-container');
    this.ruleListNameInput = document.getElementById('rule-list-name-input');
    this.addRuleListButton = document.getElementById('add-rule-list');
    this.ruleLists = [];
    this.selectedRuleListFilter = 'all';
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
      scheduleContainer: document.getElementById('rule-packs-schedule-container'),
      scheduleEditor: this.rulesUI.scheduleEditor,
      status: document.getElementById('rule-packs-status'),
      onAdd: (packId, entryIds, schedule) => this.addRulePack(packId, entryIds, schedule)
    });
    this.diagnosticsUI = new DiagnosticsUI({
      generateButton: document.getElementById('diagnostics-generate'),
      copyButton: document.getElementById('diagnostics-copy'),
      exportButton: document.getElementById('diagnostics-export'),
      clearButton: document.getElementById('diagnostics-clear'),
      output: document.getElementById('diagnostics-output'),
      status: document.getElementById('diagnostics-status'),
      onGenerate: async () => {
        const response = await sendRuntimeMessage({ type: 'diagnostics:getReport' });
        if (!response?.success) {
          const error = new Error(response?.error?.message || 'Failed to generate diagnostics');
          error.code = response?.error?.code || 'diagnostics_failed';
          throw error;
        }
        return response.report;
      },
      onClear: async () => {
        const response = await sendRuntimeMessage({ type: 'diagnostics:clearHistory' });
        if (!response?.success) {
          const error = new Error(response?.error?.message || 'Failed to clear diagnostics');
          error.code = response?.error?.code || 'diagnostics_failed';
          throw error;
        }
        return true;
      }
    });
    
    let telemetryConsentSource = 'local';
    this.telemetryUI = new TelemetryUI({
      checkbox: document.getElementById('telemetryConsent'),
      status: document.getElementById('telemetry-status'),
      onGetConsent: async () => {
        const response = await sendRuntimeMessage({ type: 'telemetry:getConsent' });
        if (!response?.success) throw new Error('Failed to read telemetry consent');
        telemetryConsentSource = response.consent?.source || 'local';
        return response.consent;
      },
      onSetConsent: async enabled => {
        if (telemetryConsentSource === 'firefox_builtin') {
          await requestTelemetryConsentFromUserAction(browser.permissions, enabled);
        }

        const response = await sendRuntimeMessage({ type: 'telemetry:setConsent', enabled });
        if (!response?.success) throw new Error('Failed to update telemetry consent');
        telemetryConsentSource = response.consent?.source || telemetryConsentSource;
        return response.consent;
      }
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
    this.diagnosticsUI.initialize();
    await this.telemetryUI.initialize();
    try {
      this.isPro = await ProManager.isPro();
      this.isLegacyUser = await ProManager.isLegacyUser();
    } catch (error) {
      this.logger.error('Error initializing Pro/Legacy status:', error);
    }
    
    this.updateWhitelistButtonState();
    
    await ProManager.initializeProFeatures();
    await this.loadRuleLists();
    await this.loadRules();
    await this.loadCategories();
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
    setContent('rule-list-header', 'rulelist_header');
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
    if (this.ruleListFilter) this.ruleListFilter.addEventListener('change', () => {
      this.selectedRuleListFilter = this.ruleListFilter.value || 'all';
      this.loadRules();
    });
    if (this.addRuleListButton) this.addRuleListButton.addEventListener('click', () => this.handleRuleListCreate());
    if (this.ruleListNameInput) {
      this.ruleListNameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') this.handleRuleListCreate();
      });
    }
    
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
    } else if (error.code === 'rule_list_name_invalid') {
      this.rulesUI.showErrorMessage(t('rulelists_name_invalid'));
    } else if (error.code === 'rule_list_name_exists') {
      this.rulesUI.showErrorMessage(t('rulelists_name_exists'));
    } else if (['rule_list_not_found', 'rule_list_locked'].includes(error.code)) {
      this.rulesUI.showErrorMessage(t('errorupdatingrules'));
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
      
      const [ruleLists, dailyUsageSeconds] = await Promise.all([
        this.ruleListsManager.getLists(),
        this.dailyLimitManager.getUsageSeconds()
      ]);
      this.ruleLists = ruleLists;

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

      const selectedList = this.selectedRuleListFilter || 'all';
      if (selectedList !== 'all') {
        filteredRules = filteredRules.filter(rule =>
          !rule.isWhitelist && isRuleInList(rule, selectedList)
        );
        isFiltered = true;
      }
      
      const canEdit = this.isPro || this.isLegacyUser || rules.length <= MAX_RULES_LIMIT;
      const settings = await SettingsManager.getSettings();
      const disabledCategories = settings.disabledCategories || [];
      const disabledRuleListIds = ruleLists.filter(list => list.disabled).map(list => list.id);
      this.renderRules(filteredRules, canEdit, isFiltered, disabledCategories, ruleLists, disabledRuleListIds, dailyUsageSeconds);
      this.rulesUI.updateStatus(this.statusElement, filteredRules.length);
      
      if (this.settingsManager) {
        this.settingsManager.loadRuleCount(rules);
      }
      
    } catch (error) {
      this.logger.error("Load rules error:", error);
      this.rulesUI.showErrorMessage(t('errorupdatingrules'));
    }
  }
  
  renderRules(rules, canEdit, isFiltered = false, disabledCategories = [], ruleLists = [], disabledRuleListIds = [], dailyUsageSeconds = {}) {
    this.rulesBody.innerHTML = '';
    const noRulesMessage = isFiltered ? t('norulesforcategory') : t('norules');
    
    if (rules.length === 0) {
      const emptyRow = this.rulesUI.createEmptyRow(noRulesMessage, 6);
      this.rulesBody.appendChild(emptyRow);
      return;
    }
    
    const displayedRules = [...rules].reverse();

    displayedRules.forEach((rule, displayIndex) => {
      const row = this.createRuleRow(rule, displayIndex, canEdit, disabledCategories, ruleLists, disabledRuleListIds, dailyUsageSeconds);

      if (isVisibleRuleGroupEnd(displayIndex, displayedRules.length)) {
        row.classList.add('rule-group-end');
      }

      this.rulesBody.appendChild(row);
    });
  }
  
  createRuleRow(rule, index, canEdit, disabledCategories = [], ruleLists = [], disabledRuleListIds = [], dailyUsageSeconds = {}) {
    const isCategoryMuted = disabledCategories.includes(rule.category);
    const isListMuted = !rule.isWhitelist && !isRuleListMembershipActive(rule, disabledRuleListIds);
    const isMuted = isCategoryMuted || isListMuted;
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
        disabledCategories,
        ruleLists,
        disabledRuleListIds,
        dailyUsageSeconds
    );
    if (isMuted) {
      row.title = isCategoryMuted ? t('category_muted_no_edit') : t('rulelists_muted_no_edit');
    }
    return row;
  }
  
  async handleRuleDeletion(event, ruleId) {
    try {
      const deleteButton = event.target;
      if (this.rulesUI.isDeleteConfirmationInProgress(deleteButton)) return;
      
      const settings = await SettingsManager.getSettings();
      const isStrictMode = settings.mode === 'strict';
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
    const ruleLists = await this.ruleListsManager.getLists();
    const isWhitelist = rule.isWhitelist || false;
    
    if (!isWhitelist && disabledCategories.includes(rule.category)) {
      this.rulesUI.showErrorMessage(t('category_muted_no_edit'));
      return;
    }
    if (!isWhitelist && !isRuleListMembershipActive(
      rule,
      ruleLists.filter(list => list.disabled).map(list => list.id)
    )) {
      this.rulesUI.showErrorMessage(t('rulelists_muted_no_edit'));
      return;
    }
    const editRow = this.rulesUI.createRuleEditRow(
      rule,
      ruleId,
      (ruleId, blockValue, redirectValue, category, blockingConfig, listIds) => this.saveEditedRule(
        ruleId,
        blockValue,
        redirectValue,
        category,
        blockingConfig,
        listIds,
        rule.disabledByUser,
        isWhitelist
      ),
      () => this.loadRules(),
      this.isPro || this.isLegacyUser,
      rule.disabledByUser,
      ruleLists
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
  
  async saveEditedRule(ruleId, newBlock, newRedirect, newCategory, blockingConfig, listIds, disabledByUser, isWhitelist = false) {
    try {
      await this.rulesClient.updateRule({
        ruleId,
        blockURL: newBlock,
        redirectURL: isWhitelist ? '' : newRedirect,
        schedule: isWhitelist ? null : blockingConfig.schedule,
        blockingMode: isWhitelist ? 'always' : blockingConfig.blockingMode,
        dailyLimit: isWhitelist ? null : blockingConfig.dailyLimit,
        category: isWhitelist ? 'whitelist' : newCategory,
        listIds: isWhitelist ? [GENERAL_RULE_LIST_ID] : listIds,
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
        (blockValue, redirectValue, category, blockingConfig, listIds, row) => this.saveNewRule(
          blockValue,
          redirectValue,
          category,
          blockingConfig,
          listIds,
          row,
          isWhitelist
        ),
        (row) => row.remove(),
        this.isPro || this.isLegacyUser,
        isWhitelist,
        this.ruleLists,
        isWhitelist ? [GENERAL_RULE_LIST_ID] : [resolveRuleListContext(
          this.ruleLists,
          this.selectedRuleListFilter || 'all'
        )]
      );
      
      this.rulesBody.insertBefore(newRow, this.rulesBody.firstChild);
    } catch (error) {
      this.logger.info('Error checking rule limit:', error);
      this.rulesUI.showErrorMessage(t('erroraddingrule'));
    }
  }
  
  async saveNewRule(newBlock, newRedirect, newCategory, blockingConfig, listIds, row, isWhitelist = false) {
    try {
      const response = await this.rulesClient.addRule({
        blockURL: newBlock,
        redirectURL: isWhitelist ? '' : newRedirect,
        schedule: isWhitelist ? null : blockingConfig.schedule,
        blockingMode: isWhitelist ? 'always' : blockingConfig.blockingMode,
        dailyLimit: isWhitelist ? null : blockingConfig.dailyLimit,
        category: isWhitelist ? 'whitelist' : newCategory,
        listIds: isWhitelist ? [GENERAL_RULE_LIST_ID] : listIds,
        isWhitelist
      });
      
      this.statusElement.textContent = response?.membershipAdded ? t('ruleupdated') : t('rulenewadded');
    } catch (error) {
      this.logger.info("Save new rule error:", error);
      this.handleRulesMutationError(error, 'errorupdatingrules');
    }
  }
  
  async addRulePack(packId, entryIds, schedule = null) {
    try {
      const targetListId = resolveRuleListContext(
        this.ruleLists,
        this.selectedRuleListFilter || 'all'
      );
      return await this.rulesClient.addMany(packId, entryIds, schedule, targetListId);
    } catch (error) {
      this.logger.error('Add rule pack error:', error);
      this.handleRulesMutationError(error, 'rulepacks_error');
      throw error;
    }
  }
  
  async loadRuleLists() {
    try {
      const [lists, rules] = await Promise.all([
        this.ruleListsManager.getLists(),
        this.rulesManager.getRules()
      ]);
      this.ruleLists = lists;

      if (this.ruleListsContainer) {
        RuleListsUI.updateListGrid(this.ruleListsContainer, lists, rules, {
          selectedListId: this.selectedRuleListFilter,
          onToggle: listId => this.handleRuleListToggle(listId),
          onSelect: listId => this.handleRuleListSelect(listId),
          onRename: list => this.handleRuleListRename(list),
          onDelete: list => this.handleRuleListDelete(list)
        });
      }

      if (this.ruleListFilter) {
        RuleListsUI.updateFilter(this.ruleListFilter, lists, this.selectedRuleListFilter);
        this.selectedRuleListFilter = this.ruleListFilter.value || 'all';
      }
    } catch (error) {
      this.logger.error('Load rule lists error:', error);
    }
  }

  async handleRuleListCreate() {
    const name = this.ruleListNameInput?.value || '';
    try {
      const response = await this.rulesClient.createRuleList(name);
      if (this.ruleListNameInput) this.ruleListNameInput.value = '';
      this.ruleLists = response.ruleLists || this.ruleLists;
      if (response.list?.id) {
        this.selectedRuleListFilter = response.list.id;
      }

      await this.loadRuleLists();
      await this.loadRules();
    } catch (error) {
      this.logger.error('Create rule list error:', error);
      this.handleRulesMutationError(error, 'errorupdatingrules');
    }
  }

  async handleRuleListSelect(listId) {
    this.selectedRuleListFilter = listId || 'all';
    if (this.ruleListFilter) this.ruleListFilter.value = this.selectedRuleListFilter;
    await Promise.all([this.loadRuleLists(), this.loadRules()]);
  }

  async handleRuleListRename(list) {
    const name = prompt(`${t('editbtn')}: ${t('rulelists_title')}`, list.name);
    if (name === null) return;
    try {
      await this.rulesClient.renameRuleList(list.id, name);
    } catch (error) {
      this.logger.error('Rename rule list error:', error);
      this.handleRulesMutationError(error, 'errorupdatingrules');
    }
  }

  async handleRuleListToggle(listId) {
    try {
      await this.rulesClient.toggleRuleList(listId);
    } catch (error) {
      this.logger.error('Toggle rule list error:', error);
      this.handleRulesMutationError(error, 'errorupdatingrules');
      await this.loadRuleLists();
    }
  }

  async handleRuleListDelete(list) {
    if (!confirm(t('rulelists_delete_confirm', list.name))) return;
    try {
      await this.rulesClient.deleteRuleList(list.id);
      if (this.selectedRuleListFilter === list.id) {
        this.selectedRuleListFilter = 'all';
      }
    } catch (error) {
      this.logger.error('Delete rule list error:', error);
      this.handleRulesMutationError(error, 'errorupdatingrules');
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
    optionsPage.loadRuleLists();
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
    optionsPage.loadRuleLists();
    optionsPage.loadRules();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    optionsPage.loadRules();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initializeNoSpaceInputs();
});