import { t } from '../scripts/t.js';
import { ProManager } from '../pro/proManager.js';
import { PasswordUtils } from '../pro/password.js';
import { StatisticsManager } from '../pro/statisticsManager.js';
import Logger from '../utils/logger.js';

export class SettingsManager {
  constructor() {
    this.defaultSettings = {
      mode: 'normal',
      confirmBeforeDelete: false,
      showNotifications: true,
      enablePassword: false,
      passwordHash: null
    };
    
    this.onRulesUpdated = null;
    
    this.init();
  }
  
  setRulesUpdatedCallback(callback) {
    this.onRulesUpdated = callback;
  }
  
  async init() {
    await this.initializeSettings();
    this.setupEventListeners();
    this.loadRuleCount();
    this.loadStatistics();
  }
  
  async initializeSettings() {
    try {
      const result = await browser.storage.sync.get(['settings']);
      
      if (!result.settings) {
        await browser.storage.sync.set({ settings: this.defaultSettings });
        this.applySettingsToUI(this.defaultSettings);
        Logger.log('Default settings initialized');
      } else {
        const mergedSettings = { ...this.defaultSettings, ...result.settings };
        const hasNewFields = Object.keys(this.defaultSettings).some(
          key => !(key in result.settings)
        );
        
        if (hasNewFields) {
          await browser.storage.sync.set({ settings: mergedSettings });
          Logger.log('Settings updated with new fields');
        }
        
        this.applySettingsToUI(mergedSettings);
      }
    } catch (error) {
      Logger.error('Error initializing settings:', error);
      this.applySettingsToUI(this.defaultSettings);
      this.showStatus(t('errorloadingsettings'), 'error');
    }
  }
  
  static async getSettings() {
    try {
      const result = await browser.storage.sync.get(['settings']);
      const defaultSettings = {
        mode: 'normal',
        confirmBeforeDelete: false,
        showNotifications: true,
        enablePassword: false,
        passwordHash: null
      };
      
      if (!result.settings) {
        await browser.storage.sync.set({ settings: defaultSettings });
        return defaultSettings;
      }
      
      return { ...defaultSettings, ...result.settings };
    } catch (error) {
      Logger.error('Error getting settings:', error);
      return {
        mode: 'normal',
        confirmBeforeDelete: false,
        showNotifications: true,
        enablePassword: false,
        passwordHash: null
      };
    }
  }
  
  applySettingsToUI(settings) {
    const modeRadios = document.querySelectorAll('input[name="securityMode"]');
    modeRadios.forEach(radio => {
      radio.checked = radio.value === settings.mode;
    });
    
    const confirmBox = document.getElementById('confirmBeforeDelete');
    if (confirmBox) confirmBox.checked = settings.confirmBeforeDelete;
    
    const notifBox = document.getElementById('showNotifications');
    if (notifBox) notifBox.checked = settings.showNotifications;
    
    const passBox = document.getElementById('enablePassword');
    if (passBox) passBox.checked = settings.enablePassword;
  }
  
  async saveSettings(settingsToSave) {
    try {
      const result = await browser.storage.sync.get(['settings']);
      const currentSettings = result.settings || this.defaultSettings;
      const newSettings = { ...currentSettings, ...settingsToSave };
      
      await browser.storage.sync.set({ settings: newSettings });
      this.showStatus(t('settingssaved'), 'success');
    } catch (error) {
      Logger.error('Error saving settings:', error);
      this.showStatus(t('errorsavingsettings'), 'error');
    }
  }
  
  getSettingsFromUI() {
    const mode = document.querySelector('input[name="securityMode"]:checked')?.value || 'normal';
    const confirmBeforeDelete = document.getElementById('confirmBeforeDelete').checked;
    const showNotifications = document.getElementById('showNotifications').checked;
    const enablePassword = document.getElementById('enablePassword').checked;
    
    return {
      mode,
      confirmBeforeDelete,
      showNotifications,
      enablePassword
    };
  }
  
  async checkPasswordProtection() {
    const settings = await SettingsManager.getSettings();
    if (settings.enablePassword) {
      return new Promise((resolve) => {
        PasswordUtils.showPasswordModal('verify', (isValid) => {
          resolve(isValid);
        }, t);
      });
    }
    return true;
  }
  
  setupEventListeners() {
    const inputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]:not(#enablePassword)');
    inputs.forEach(input => {
      input.addEventListener('change', async (e) => {
        const settingsToSave = {};
        if (e.target.name === 'securityMode') {
          settingsToSave.mode = e.target.value;
        } else {
          settingsToSave[e.target.id] = e.target.checked;
        }
        
        await this.saveSettings(settingsToSave);
      });
    });
    
    const enablePasswordToggle = document.getElementById('enablePassword');
    if (enablePasswordToggle) {
      enablePasswordToggle.addEventListener('click', async (event) => {
        event.preventDefault();
        
        if (!await ProManager.isPro()) {
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
      if (!await ProManager.isPro()) { this.showStatus(t('prorequired'), 'error'); return; }
      this.exportRules();
    });
    
    document.getElementById('importRules').addEventListener('click', async () => {
      if (!await ProManager.isPro()) { this.showStatus(t('prorequired'), 'error'); return; }
      document.getElementById('importFileInput').click();
    });
    
    document.getElementById('importFileInput').addEventListener('change', (e) => {
      this.importRules(e.target.files[0]);
    });
    
    document.getElementById('clearAllRules').addEventListener('click', async () => {
      if (!await ProManager.isPro()) { this.showStatus(t('prorequired'), 'error'); return; }
      
      const isAuthorized = await this.checkPasswordProtection();
      if (!isAuthorized) return;
      
      this.clearAllRules();
    });
    
    document.getElementById('resetSettings').addEventListener('click', async () => {
      if (!await ProManager.isPro()) { this.showStatus(t('prorequired'), 'error'); return; }
      
      const isAuthorized = await this.checkPasswordProtection();
      if (!isAuthorized) return;
      
      this.resetSettings();
    });
    
    const clearStatsBtn = document.getElementById('clearStatistics');
    if (clearStatsBtn) {
      clearStatsBtn.addEventListener('click', async () => {
        if (!await ProManager.isPro()) { this.showStatus(t('prorequired'), 'error'); return; }
        
        const isAuthorized = await this.checkPasswordProtection();
        if (!isAuthorized) return;
        
        if (confirm(t('confirmclearstats'))) {
          await StatisticsManager.reset();
          await this.loadStatistics();
          this.showStatus(t('statscleared'), 'success');
        }
      });
    }
    
    browser.storage.onChanged.addListener(this.handleStorageChange.bind(this));
  }
  
  handleStorageChange(changes, namespace) {
    if (namespace === 'local' && changes.statistics) {
      Logger.log('Statistics changed in storage, reloading stats UI...');
      this.loadStatistics();
    }
  }
  
  async loadRuleCount(rules_from_message = null) {
    try {
      let rules;
      if (rules_from_message) {
        rules = rules_from_message;
      } else {
        const rulesResult = await browser.storage.sync.get(['rules']);
        rules = rulesResult.rules || [];
      }
      const el = document.getElementById('totalRules');
      if (el) el.textContent = rules.length;
    } catch (error) {
      Logger.error('Error loading rule count:', error);
    }
  }
  
  async loadStatistics() {
    try {
      const statsResult = await browser.storage.local.get(['statistics']);
      const stats = statsResult.statistics || StatisticsManager.defaultStats;
      
      const today = new Date().toDateString();
      if (stats.lastResetDate !== today) {
        stats.blockedToday = 0;
        stats.redirectsToday = 0;
      }
      
      const setStatsText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      
      setStatsText('totalBlocked', stats.totalBlocked || 0);
      setStatsText('blockedToday', stats.blockedToday || 0);
      setStatsText('totalRedirects', stats.totalRedirects || 0);
      setStatsText('redirectsToday', stats.redirectsToday || 0);
    } catch (error) {
      Logger.error('Error loading statistics:', error);
    }
  }
  
  async exportRules() {
    try {
      const result = await browser.storage.sync.get(['rules', 'settings']);
      const exportData = {
        rules: result.rules || [],
        settings: result.settings || this.defaultSettings,
        exportDate: new Date().toISOString(),
        version: browser.runtime.getManifest().version
      };
      
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
      Logger.error('Error exporting rules:', error);
      this.showStatus(t('errorexportingrules'), 'error');
    }
  }
  
  async importRules(file) {
    if (!file) return;
    
    try {
      const text = await file.text();
      const importData = JSON.parse(text);
      
      if (!importData.rules || !Array.isArray(importData.rules)) {
        throw new Error('Invalid file format: missing rules array');
      }
      
      const confirmImport = confirm(
        t('willimportrules', `${importData.rules.length}`) +
        t('ruleswillbereplaced')
      );
      
      if (!confirmImport) return;
      
      const saveData = {
        rules: importData.rules
      };
      
      if (importData.settings) {
        saveData.settings = { ...this.defaultSettings, ...importData.settings };
      }
      
      await browser.storage.sync.set(saveData);
      
      if (saveData.settings) {
        this.applySettingsToUI(saveData.settings);
      }
      
      await this.loadRuleCount(saveData.rules);
      await this.loadStatistics();
      
      this.showStatus(t('importedrules', `${importData.rules.length}`), 'success');
      
      document.getElementById('importFileInput').value = '';
      
      if (this.onRulesUpdated) {
        this.onRulesUpdated();
      }
      
      this.notifyOptionsReload();
    } catch (error) {
      Logger.error('Error importing rules:', error);
      this.showStatus(t('errorimportingrules') + error.message, 'error');
    }
  }
  
  async clearAllRules() {
    const result = await browser.storage.sync.get('rules');
    const rulesCount = result.rules?.length || 0;
    
    if (rulesCount === 0) {
      this.showStatus(t('norulestoclear'), 'error');
      return;
    }
    
    const confirmClear = confirm(
      t('willdeleteallrules', `${rulesCount}`) +
      t('cannotbeundone')
    );
    
    if (!confirmClear) return;
    
    try {
      browser.runtime.sendMessage({
        type: 'delete_all_rules'
      });
      
      await this.loadRuleCount([]);
      this.showStatus(t('allrulescleared'), 'success');
      
      if (this.onRulesUpdated) {
        this.onRulesUpdated();
      }
      this.notifyOptionsReload();
    } catch (error) {
      Logger.error('Error clearing rules:', error);
      this.showStatus(t('errorclearingrules'), 'error');
    }
  }
  
  async resetSettings() {
    const confirmReset = confirm(t('willreset'));
    
    if (!confirmReset) return;
    
    try {
      await browser.storage.sync.set({ settings: this.defaultSettings });
      this.applySettingsToUI(this.defaultSettings);
      this.showStatus(t('resettodefaults'), 'success');
      
      setTimeout(() => window.location.reload(), 1000);
    } catch (error) {
      Logger.error('Error resetting settings:', error);
      this.showStatus(t('errorresettingsettings'), 'error');
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
  
  notifyOptionsReload() {
    try {
      browser.runtime.sendMessage({
        type: 'reload_rules'
      });
    } catch (e) {
      Logger.log("Could not send reload message (maybe background inactive)", e);
    }
  }
}