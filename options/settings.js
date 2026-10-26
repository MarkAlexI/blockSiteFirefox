import { t } from '../scripts/t.js';
import { ProManager } from '../pro/proManager.js';
import { PasswordUtils } from '../pro/password.js';
import { StatisticsManager } from '../pro/statisticsManager.js';
import { getFocusSessionState } from '../utils/focusSession.js';
import Logger from '../utils/logger.js';
import { RulesClient } from '../rules/rulesClient.js';
import { getRulesMutationFeedback } from '../rules/rulesMutationFeedback.js';
import { renderStatisticsCharts } from './statisticsCharts.js';
import {
  MAX_BACKUP_FILE_BYTES,
  createBackupDocument,
  parseBackupText
} from '../backup/backupFormat.js';

export class SettingsManager {
  constructor() {
    this.logger = new Logger('SettingsManager');
    this.rulesClient = new RulesClient();
    this.defaultSettings = {
      mode: 'normal',
      confirmBeforeDelete: false,
      showNotifications: true,
      enablePassword: false,
      passwordHash: null,
      debugMode: false,
      focusSessionSound: true
    };
    
    this.focusBanner = document.getElementById('focus-session-banner');
    this.focusBannerTimer = document.getElementById('focus-banner-timer');
    this.focusTimerInterval = null;
    this.statisticsRangeDays = 30;
    this.statisticsRequestedRangeDays = this.statisticsRangeDays;
    this.statisticsLoadGeneration = 0;
    this.statisticsLoading = false;
    this.statisticsClearPending = false;
    this.statisticsReadFailed = false;
    this.statisticsActionFeedback = null;
    this.settingsAction = null;
    this.settingsEditVersions = {};
    this.settingsSavePromise = Promise.resolve();
    
    this.init();
  }
  
  async init() {
    await this.initializeSettings();
    this.setupEventListeners();
    this.loadRuleCount();
    this.loadStatistics();
    await this.initFocusSessionBanner();
  }
  
  async initializeSettings() {
    try {
      const result = await browser.storage.sync.get(['settings']);
      
      if (!result.settings) {
        await browser.storage.sync.set({ settings: this.defaultSettings });
        this.applySettingsToUI(this.defaultSettings);
        this.logger.log('Default settings initialized');
      } else {
        const mergedSettings = { ...this.defaultSettings, ...result.settings };
        
        const hasNewFields = Object.keys(this.defaultSettings).some(
          key => !(key in result.settings)
        );
        
        if (hasNewFields) {
          await browser.storage.sync.set({ settings: mergedSettings });
          this.logger.log('Settings updated with new fields');
        }
        
        this.applySettingsToUI(mergedSettings);
      }
    } catch (error) {
      this.logger.error('Error initializing settings:', error);
      this.applySettingsToUI(this.defaultSettings);
      this.showStatus(t('errorloadingsettings'), 'error');
    }
  }
  
  static async getSettings({ throwOnError = false } = {}) {
    const logger = new Logger('SettingsManager:Static');
    try {
      const result = await browser.storage.sync.get(['settings']);
      const defaultSettings = {
        mode: 'normal',
        confirmBeforeDelete: false,
        showNotifications: true,
        enablePassword: false,
        passwordHash: null,
        debugMode: false,
        focusSessionSound: true
      };
      
      if (!result.settings) {
        await browser.storage.sync.set({ settings: defaultSettings });
        return defaultSettings;
      }
      
      return { ...defaultSettings, ...result.settings };
    } catch (error) {
      logger.error('Error getting settings:', error);
      if (throwOnError) throw error;
      return {
        mode: 'normal',
        confirmBeforeDelete: false,
        showNotifications: true,
        enablePassword: false,
        passwordHash: null,
        debugMode: false,
        focusSessionSound: true
      };
    }
  }
  
  applySettingsToUI(settings, { preserveEdits = null } = {}) {
    const canApply = key => !preserveEdits ||
      (this.settingsEditVersions?.[key] || 0) === (preserveEdits[key] || 0);
    if (canApply('mode')) {
      document.querySelectorAll('input[name="securityMode"]').forEach(radio => {
        radio.checked = radio.value === settings.mode;
      });
    }
    for (const [id, key] of [
      ['confirmBeforeDelete', 'confirmBeforeDelete'], ['showNotifications', 'showNotifications'],
      ['enablePassword', 'enablePassword'], ['enableDebug', 'debugMode'],
      ['focusSessionSound', 'focusSessionSound']
    ]) {
      const input = document.getElementById(id);
      if (input && canApply(key)) input.checked = settings[key];
    }
  }

  async saveSettings(settingsToSave) {
    // A reset must not repaint a newer field choice. Mark the intent before any
    // await, even when its value happens to match the old displayed value.
    this.settingsEditVersions ||= {};
    for (const key of Object.keys(settingsToSave || {})) {
      this.settingsEditVersions[key] = (this.settingsEditVersions[key] || 0) + 1;
    }
    const reset = this.settingsAction?.buttonId === 'resetSettings' ? this.settingsAction.finished : null;
    const previous = this.settingsSavePromise || Promise.resolve();
    const saving = previous.catch(() => {}).then(async () => {
      if (reset) await reset;
      try {
        const result = await browser.storage.sync.get(['settings']);
        const currentSettings = result.settings || this.defaultSettings;
        const newSettings = { ...currentSettings, ...settingsToSave };
        await browser.storage.sync.set({ settings: newSettings });
        this.showStatus(t('settingssaved'), 'success');
      } catch (error) {
        this.logger.error('Error saving settings:', error);
        this.showStatus(t('errorsavingsettings'), 'error');
      }
    });
    this.settingsSavePromise = saving;
    return saving;
  }

  getSettingsFromUI() {
    const mode = document.querySelector('input[name="securityMode"]:checked')?.value || 'normal';
    const confirmBeforeDelete = document.getElementById('confirmBeforeDelete').checked;
    const showNotifications = document.getElementById('showNotifications').checked;
    const enablePassword = document.getElementById('enablePassword').checked;
    const debugMode = document.getElementById('enableDebug')?.checked || false;
    const focusSessionSound = document.getElementById('focusSessionSound')?.checked || false;
    
    return {
      mode,
      confirmBeforeDelete,
      showNotifications,
      enablePassword,
      debugMode,
      focusSessionSound
    };
  }
  
  toggleUIAccessibility(locked) {
    const elementsToLock = [
      ...document.querySelectorAll('.collapsible-section'),
      document.getElementById('search-filter-container'),
      document.getElementById('add-rule'),
      document.querySelector('.table-wrapper'),
      document.getElementById('add-whitelist-rule')
    ];
    
    elementsToLock.forEach(el => {
      if (el) {
        el.classList.toggle('focus-lock-active', locked);
      }
    });
  }
  
  async initFocusSessionBanner() {
    const renderGeneration = this.focusRenderGeneration = (this.focusRenderGeneration || 0) + 1;
    if (this.focusTimerInterval) {
      clearInterval(this.focusTimerInterval);
      this.focusTimerInterval = null;
    }
    
    const { focusActive, focusEndTime } = await getFocusSessionState();
    if (renderGeneration !== this.focusRenderGeneration) return;
    
    if (focusActive && focusEndTime > Date.now()) {
      this.focusBanner.classList.remove('hidden');
      this.toggleUIAccessibility(true);
      this.updateBannerTimer(focusEndTime);
      this.focusTimerInterval = setInterval(() => this.updateBannerTimer(focusEndTime), 1000);
    } else {
      this.focusBanner.classList.add('hidden');
      this.toggleUIAccessibility(false);
    }
  }
  
  updateBannerTimer(endTime) {
    const now = Date.now();
    const remaining = endTime - now;
    
    if (remaining <= 0) {
      this.focusBannerTimer.textContent = '00:00';
      clearInterval(this.focusTimerInterval);
      this.focusTimerInterval = null;
      this.focusBanner.classList.add('hidden');
      this.toggleUIAccessibility(false);
      return;
    }
    
    const totalSeconds = Math.floor(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    this.focusBannerTimer.textContent = hours > 0 ?
      `${hours.toString().padStart(2, '0')}:${minutes}:${seconds}` :
      `${minutes}:${seconds}`;
  }
  
  async checkPasswordProtection({ throwOnError = false, canPrompt = () => true } = {}) {
    try {
      const settings = await SettingsManager.getSettings({ throwOnError: true });
      if (!canPrompt()) return false;
      if (settings.enablePassword) {
        return await new Promise((resolve) => {
          PasswordUtils.showPasswordModal('verify', (isValid) => {
            resolve(isValid);
          }, t);
        });
      }
      return true;
    } catch (error) {
      this.logger.error('Error checking password protection:', error);
      if (throwOnError) throw error;
      this.showStatus(t('errorloadingsettings'), 'error');
      return false;
    }
  }
  
  async previewFocusSound() {
    if (this.focusSoundPreviewPending) return;
    const button = document.getElementById('previewFocusSound');
    const status = document.getElementById('focusSoundStatus');
    if (!button || !status) return;
    this.focusSoundPreviewPending = true;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    status.textContent = '';
    try {
      const result = await browser.runtime.sendMessage({ type: 'sound:preview' });
      status.textContent = t(result?.success === true ? 'soundpreviewcomplete' : 'soundpreviewfailed');
    } catch {
      status.textContent = t('soundpreviewfailed');
    } finally {
      this.focusSoundPreviewPending = false;
      button.setAttribute('aria-disabled', 'false');
      button.setAttribute('aria-busy', 'false');
    }
  }

  setupEventListeners() {
    document.getElementById('previewFocusSound')?.addEventListener('click', () => this.previewFocusSound());
    const inputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]:not(#enablePassword):not(#focusSessionSound):not(#telemetryConsent)');
    
    inputs.forEach(input => {
      input.addEventListener('change', async (e) => {
        const settingsToSave = {};
        if (e.target.name === 'securityMode') {
          settingsToSave.mode = e.target.value;
        } else if (e.target.id === 'enableDebug') {
          settingsToSave.debugMode = e.target.checked;
          this.logger.info(`Debug mode changed to: ${e.target.checked}`);
        } else {
          settingsToSave[e.target.id] = e.target.checked;
        }
        
        await this.saveSettings(settingsToSave);
      });
    });
    
    const focusSoundCheckbox = document.getElementById('focusSessionSound');
    if (focusSoundCheckbox) {
      focusSoundCheckbox.addEventListener('change', async (e) => {
        await this.saveSettings({ focusSessionSound: e.target.checked });
      });
    }
    
    const enablePasswordToggle = document.getElementById('enablePassword');
    if (enablePasswordToggle) {
      enablePasswordToggle.addEventListener('click', async (event) => {
        event.preventDefault();
        
        if (!await ProManager.hasPaidAccess()) {
          this.showStatus(t('prorequired'), 'error');
          return;
        }
        
        const enable = !enablePasswordToggle.checked;
        
        if (enable) {
          PasswordUtils.showPasswordModal('set', async (hash) => {
            if (hash) {
              await this.saveSettings({ enablePassword: true, passwordHash: hash });
              enablePasswordToggle.checked = true;
              this.showStatus(t('passwordset'), 'success');
            }
          }, t);
        } else {
          PasswordUtils.showPasswordModal('verify', async (isValid) => {
            if (isValid) {
              await this.saveSettings({ enablePassword: false, passwordHash: null });
              enablePasswordToggle.checked = false;
              this.showStatus(t('passworddisabled'), 'success');
            }
          }, t);
        }
      });
    }
    
    document.getElementById('exportRules').addEventListener('click', async () => {
      if (!await ProManager.hasPaidAccess()) { this.showStatus(t('prorequired'), 'error'); return; }
      this.exportRules();
    });
    
    document.getElementById('importRules').addEventListener('click', () => this.chooseImportFile());
    
    document.getElementById('importFileInput').addEventListener('change', (e) => {
      return this.importRules(e.target.files?.[0]);
    });
    
    document.getElementById('clearAllRules').addEventListener('click', () => this.clearAllRules());
    document.getElementById('resetSettings').addEventListener('click', () => this.resetSettings());
    
    const clearStatsBtn = document.getElementById('clearStatistics');
    if (clearStatsBtn) {
      clearStatsBtn.addEventListener('click', () => this.clearStatistics());
    }
    
    document.querySelectorAll('[data-stat-range]').forEach(button => {
      const days = Number(button.dataset.statRange);
      button.textContent = `${days} ${t('days')}`;
      button.addEventListener('click', () => {
        if (days !== 7 && days !== 30) return;
        this.statisticsRequestedRangeDays = days;
        this.statisticsActionFeedback = null;
        this.updateStatisticsStatus();
        return this.loadStatistics();
      });
    });
    this.updateStatisticsRangeControls();

    browser.storage.onChanged.addListener(this.handleStorageChange.bind(this));
  }
  
  updateStatisticsRangeControls() {
    document.querySelectorAll('[data-stat-range]').forEach(button => {
      const active = Number(button.dataset.statRange) === this.statisticsRangeDays;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  handleStorageChange(changes, namespace) {
    if (namespace === 'local' && changes.statistics) {
      this.logger.log('Statistics changed in storage, reloading stats UI...');
      this.loadStatistics();
    }
    
    if (changes.focusSession) {
      this.logger.log('Focus session state changed, updating Banner and UI...');
      this.initFocusSessionBanner();
    }
  }
  
  async loadRuleCount(rules_from_message = null, { throwOnError = false } = {}) {
    const generation = this.ruleCountGeneration = (this.ruleCountGeneration || 0) + 1;
    try {
      let rules;
      if (rules_from_message) {
        rules = rules_from_message;
      } else {
        const rulesResult = await browser.storage.local.get(['rules']);
        rules = rulesResult.rules || [];
      }
      if (generation !== this.ruleCountGeneration) return false;
      const el = document.getElementById('totalRules');
      if (el) el.textContent = rules.length;
      return true;
    } catch (error) {
      if (generation !== this.ruleCountGeneration) return false;
      this.logger.error('Error loading rule count:', error);
      if (throwOnError) throw error;
      return false;
    }
  }
  
  async loadStatistics() {
    const generation = this.statisticsLoadGeneration = (this.statisticsLoadGeneration || 0) + 1;
    const days = this.statisticsRequestedRangeDays ?? this.statisticsRangeDays ?? 30;
    this.statisticsLoading = true;
    this.updateStatisticsBusyState();
    try {
      const stats = await StatisticsManager.getStatistics({ throwOnError: true });
      if (generation !== this.statisticsLoadGeneration) return false;
      
      const setStatsText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      
      setStatsText('totalBlocked', stats.totalBlocked || 0);
      setStatsText('blockedToday', stats.blockedToday || 0);
      setStatsText('totalRedirects', stats.totalRedirects || 0);
      setStatsText('redirectsToday', stats.redirectsToday || 0);
      setStatsText('successfulFocusSessions', stats.successfulFocusSessions || 0);

      const { totals } = renderStatisticsCharts({
        stats,
        days,
        activityContainer: document.getElementById('statsActivityChart'),
        focusContainer: document.getElementById('statsFocusChart'),
        labels: {
          blocked: t('totalblockedlabel'),
          redirected: t('totalredirectslabel'),
          focus: t('successfulfocussessionslabel')
        }
      });

      setStatsText('statsBlockedRangeTotal', totals.blocked);
      setStatsText('statsRedirectedRangeTotal', totals.redirected);
      setStatsText('statsFocusRangeTotal', totals.focusSessions);
      this.statisticsRangeDays = days;
      this.updateStatisticsRangeControls();
      this.statisticsReadFailed = false;
      this.updateStatisticsStatus();
      return true;
    } catch (error) {
      if (generation !== this.statisticsLoadGeneration) return false;
      this.logger.error('Error loading statistics:', error);
      this.statisticsRequestedRangeDays = this.statisticsRangeDays;
      this.statisticsReadFailed = true;
      this.updateStatisticsStatus();
      return false;
    } finally {
      if (generation === this.statisticsLoadGeneration) {
        this.statisticsLoading = false;
        this.updateStatisticsBusyState();
      }
    }
  }

  updateStatisticsBusyState() {
    document.getElementById('statistics-panel')?.setAttribute('aria-busy',
      String(Boolean(this.statisticsLoading || this.statisticsClearPending)));
  }

  updateStatisticsStatus() {
    const element = document.getElementById('statisticsStatus');
    if (!element) return;
    const messages = [this.statisticsActionFeedback?.message,
      this.statisticsReadFailed ? t('statisticsloadfailed') : null].filter(Boolean);
    const message = messages.join(' ');
    if (element.textContent !== message) element.textContent = message;
    element.classList.toggle('error', Boolean(this.statisticsReadFailed || this.statisticsActionFeedback?.error));
  }

  async clearStatistics() {
    // Acquire the guard before Pro/password reads, not just before the write.
    if (this.statisticsClearPending) return false;
    this.statisticsClearPending = true;
    this.statisticsActionFeedback = null;
    this.updateStatisticsStatus();
    const button = document.getElementById('clearStatistics');
    const previousDisabled = button?.getAttribute('aria-disabled');
    button?.setAttribute('aria-disabled', 'true');
    this.updateStatisticsBusyState();
    try {
      if (!await ProManager.hasPaidAccess()) {
        this.statisticsActionFeedback = { message: t('prorequired'), error: true };
        return false;
      }
      if (!await this.checkPasswordProtection() || !confirm(t('confirmclearstats'))) return false;
      // A read begun before this mutation cannot repaint the cleared history,
      // including if reset fails and there is no following refresh to replace it.
      this.statisticsLoadGeneration = (this.statisticsLoadGeneration || 0) + 1;
      this.statisticsLoading = false;
      await StatisticsManager.reset({ throwOnError: true });
      this.statisticsActionFeedback = { message: t('statscleared'), error: false };
      await this.loadStatistics();
      return true;
    } catch (error) {
      this.logger.error('Error clearing statistics:', error);
      this.statisticsActionFeedback = { message: t('statisticsclearfailed'), error: true };
      return false;
    } finally {
      this.statisticsClearPending = false;
      if (previousDisabled === null || previousDisabled === undefined) button?.removeAttribute('aria-disabled');
      else button?.setAttribute('aria-disabled', previousDisabled);
      this.updateStatisticsBusyState();
      this.updateStatisticsStatus();
    }
  }
  
  async exportRules() {
    try {
      const resultSync = await browser.storage.sync.get(['settings']);
      const resultLocal = await browser.storage.local.get(['rules', 'ruleLists', 'activeRuleListId']);
      const exportData = createBackupDocument({
        rules: resultLocal.rules || [],
        ruleLists: resultLocal.ruleLists || [{ id: 'general', name: 'General', disabledCategories: [] }],
        activeRuleListId: resultLocal.activeRuleListId || 'general',
        settings: resultSync.settings || this.defaultSettings,
        exportDate: new Date().toISOString(),
        version: browser.runtime.getManifest().version
      });
      
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `extension-rules-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.showStatus(t('rulesexported'), 'success');
    } catch (error) {
      this.logger.error('Error exporting rules:', error);
      this.showStatus(t('errorexportingrules'), 'error');
    }
  }
  
  beginSettingsAction(buttonId) {
    if (this.settingsAction) return null;
    const action = { buttonId, editVersions: { ...this.settingsEditVersions } };
    action.finished = new Promise(resolve => { action.resolveFinished = resolve; });
    this.settingsAction = action;
    this.updateSettingsActionState();
    return action;
  }

  finishSettingsAction(action) {
    if (this.settingsAction !== action) return;
    this.settingsAction = null;
    this.updateSettingsActionState();
    action.resolveFinished();
  }

  updateSettingsActionState() {
    for (const id of ['importRules', 'clearAllRules', 'resetSettings']) {
      const button = document.getElementById(id);
      // Retain keyboard position while rejecting conflicting activation.
      button?.setAttribute('aria-disabled', String(Boolean(this.settingsAction)));
      button?.setAttribute('aria-busy', String(this.settingsAction?.buttonId === id));
    }
  }

  setSettingsActionStatus(id, message, type = '') {
    const status = document.getElementById(id);
    if (!status) return;
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('error', type === 'error');
  }

  setImportStatus(message, type = '') {
    this.setSettingsActionStatus('importStatus', message, type);
  }

  isSettingsPromptCurrent(opener) {
    return document.visibilityState !== 'hidden' &&
      (typeof document.hasFocus !== 'function' || document.hasFocus()) &&
      (!opener || (document.activeElement === opener && opener.isConnected !== false &&
        !opener.closest('[hidden], .hidden, [inert], .focus-lock-active'))) &&
      !document.querySelector('dialog[open]');
  }

  async chooseImportFile() {
    const action = this.beginSettingsAction('importRules');
    if (!action) return false;
    const opener = document.activeElement;
    try {
      if (!await ProManager.hasPaidAccess()) {
        this.setImportStatus(t('prorequired'), 'error');
        return false;
      }
      if (!this.isSettingsPromptCurrent(opener)) {
        this.setImportStatus(t('importcancelled'));
        return false;
      }
      const input = document.getElementById('importFileInput');
      input.value = '';
      input.click();
      return true;
    } catch (error) {
      this.logger.error('Error choosing import file:', error);
      this.setImportStatus(t('importfailed'), 'error');
      return false;
    } finally {
      // The browser owns the picker. Do not leave a lock waiting for a cancel
      // event: older browsers may not emit it, or may emit an empty change.
      this.finishSettingsAction(action);
    }
  }

  async importRules(file) {
    if (!file) return false;
    const action = this.beginSettingsAction('importRules');
    if (!action) return false;
    // Acquire before access checks and file reads. A second selection cannot
    // begin another password prompt, confirmation or replacement.
    const opener = document.activeElement;
    this.setImportStatus(t('importinprogress'));
    // Release this selection synchronously, never from a late continuation.
    // This also permits an explicit retry with the very same file.
    const input = document.getElementById('importFileInput');
    if (input) input.value = '';
    try {
      if (!await ProManager.hasPaidAccess()) {
        this.setImportStatus(t('prorequired'), 'error');
        return false;
      }
      if (!file.name.toLowerCase().endsWith('.json')) {
        this.setImportStatus(t('errorinvalidfiletype'), 'error');
        return false;
      }
      if (Number.isFinite(file.size) && file.size > MAX_BACKUP_FILE_BYTES) {
        this.setImportStatus(t('importfiletoolarge'), 'error');
        return false;
      }
      const text = await file.text();
      if (text.length > MAX_BACKUP_FILE_BYTES) {
        this.setImportStatus(t('importfiletoolarge'), 'error');
        return false;
      }
      const importData = parseBackupText(text);
      const canPrompt = () => this.isSettingsPromptCurrent(opener);
      if (!canPrompt() || !await this.checkPasswordProtection({ throwOnError: true, canPrompt }) || !canPrompt()) {
        this.setImportStatus(t('importcancelled'));
        return false;
      }
      const confirmImport = confirm(
        t('willimportrules', `${importData.rules.length}`) +
        t('ruleswillbereplaced')
      );
      if (!confirmImport) {
        this.setImportStatus(t('importcancelled'));
        return false;
      }
      const response = await this.rulesClient.replaceAll(importData);
      const feedback = getRulesMutationFeedback(response, t('importedrules', `${importData.rules.length}`));
      // The worker has committed. A subsequent UI failure must not suggest
      // replaying the mutation, especially when browser synchronization waits.
      try {
        if (response.settings) this.applySettingsToUI(response.settings);
        await this.loadRuleCount(response.rules || []);
        await this.loadStatistics();
      } catch (error) {
        this.logger.error('Error refreshing imported state:', error);
        this.setImportStatus(`${feedback.message} ${t('importrefreshfailed')}`, 'error');
        return true;
      }
      this.setImportStatus(feedback.message, feedback.pending ? 'error' : '');
      return true;
    } catch (error) {
      this.logger.error('Error importing rules:', error);
      const invalidBackup = error.code === 'invalid_import' || error.code === 'validation_failed';
      this.setImportStatus(t(invalidBackup ? 'importinvalidbackup' : 'importfailed'), 'error');
      return false;
    } finally {
      this.finishSettingsAction(action);
    }
  }
  
  async clearAllRules() {
    const action = this.beginSettingsAction('clearAllRules');
    if (!action) return false;
    const opener = document.activeElement;
    const status = (message, type = '') => this.setSettingsActionStatus('clearRulesStatus', message, type);
    status(t('clearingallrules'));
    try {
      if (!await ProManager.hasPaidAccess()) {
        status(t('prorequired'), 'error');
        return false;
      }
      // Capture the confirmed set before password/confirm; the worker checks
      // its generation again inside the same queue as imports and deletions.
      const result = await browser.storage.local.get(['rules', 'rulesGeneration']);
      const rules = result.rules ?? [];
      if (!Array.isArray(rules)) throw new Error('Invalid stored rules');
      if (rules.length === 0) {
        status(t('norulestoclear'));
        return false;
      }
      const canPrompt = () => this.isSettingsPromptCurrent(opener);
      if (!canPrompt() || !await this.checkPasswordProtection({ throwOnError: true, canPrompt }) ||
          !canPrompt() || !confirm(t('willdeleteallrules', `${rules.length}`) + t('cannotbeundone'))) {
        status(t('settingsactioncancelled'));
        return false;
      }
      const response = await this.rulesClient.clearRules(result.rulesGeneration ?? null);
      const feedback = getRulesMutationFeedback(response, t('allrulescleared'));
      try {
        await this.loadRuleCount(null, { throwOnError: true });
      } catch (error) {
        this.logger.error('Error refreshing cleared rules:', error);
        status(`${feedback.message} ${t('importrefreshfailed')}`, 'error');
        return true;
      }
      status(feedback.message, feedback.pending ? 'error' : '');
      return true;
    } catch (error) {
      this.logger.error('Error clearing rules:', error);
      status(t(error.code === 'rules_state_changed' ? 'clearruleschanged' : 'errorclearingrules'), 'error');
      return false;
    } finally {
      this.finishSettingsAction(action);
    }
  }

  async resetSettings() {
    const action = this.beginSettingsAction('resetSettings');
    if (!action) return false;
    const opener = document.activeElement;
    const previousSave = this.settingsSavePromise;
    const status = (message, type = '') => this.setSettingsActionStatus('resetSettingsStatus', message, type);
    status(t('resettingsettings'));
    try {
      if (!await ProManager.hasPaidAccess()) {
        status(t('prorequired'), 'error');
        return false;
      }
      await previousSave;
      const canPrompt = () => this.isSettingsPromptCurrent(opener);
      if (!canPrompt() || !await this.checkPasswordProtection({ throwOnError: true, canPrompt }) ||
          !canPrompt() || !confirm(t('willreset'))) {
        status(t('settingsactioncancelled'));
        return false;
      }
      const defaults = { ...this.defaultSettings };
      await browser.storage.sync.set({ settings: defaults });
      // Storage listeners already update runtime behavior. Keep this document,
      // disclosures, Search draft and the user's later focus choice intact.
      try {
        this.applySettingsToUI(defaults, { preserveEdits: action.editVersions });
      } catch (error) {
        this.logger.error('Error displaying reset settings:', error);
        status(`${t('resettodefaults')} ${t('importrefreshfailed')}`, 'error');
        return true;
      }
      status(t('resettodefaults'));
      return true;
    } catch (error) {
      this.logger.error('Error resetting settings:', error);
      status(t('errorresettingsettings'), 'error');
      return false;
    } finally {
      this.finishSettingsAction(action);
    }
  }

  showStatus(message, type = 'success') {
    const statusElement = document.getElementById('statusMessage');
    if (!statusElement) return;
    
    statusElement.textContent = message;
    statusElement.className = `status-message ${type} show`;
    
    setTimeout(() => {
      statusElement.classList.remove('show');
    }, 3000);
  }
  
}
