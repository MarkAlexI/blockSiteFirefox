import { t } from '../scripts/t.js';
import { ProManager } from '../pro/proManager.js';

const isPro = ProManager.isPro();

export class SettingsManager {
  constructor() {
    this.defaultSettings = {
      mode: 'normal',
      confirmBeforeDelete: false,
      showNotifications: true
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
    this.loadStatistics();
  }
  
  async initializeSettings() {
    try {
      const result = await browser.storage.sync.get(['settings']);
      
      if (!result.settings) {
        await browser.storage.sync.set({ settings: this.defaultSettings });
        this.applySettingsToUI(this.defaultSettings);
        console.log('Default settings initialized');
      } else {
        const mergedSettings = { ...this.defaultSettings, ...result.settings };
        const hasNewFields = Object.keys(this.defaultSettings).some(
          key => !(key in result.settings)
        );
        
        if (hasNewFields) {
          await browser.storage.sync.set({ settings: mergedSettings });
          console.log('Settings updated with new fields');
        }
        
        this.applySettingsToUI(mergedSettings);
      }
    } catch (error) {
      console.error('Error initializing settings:', error);
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
        showNotifications: true
      };
      
      if (!result.settings) {
        await browser.storage.sync.set({ settings: defaultSettings });
        return defaultSettings;
      }
      
      return { ...defaultSettings, ...result.settings };
    } catch (error) {
      console.error('Error getting settings:', error);
      return {
        mode: 'normal',
        confirmBeforeDelete: false,
        showNotifications: true
      };
    }
  }
  
  applySettingsToUI(settings) {
    const modeRadios = document.querySelectorAll('input[name="securityMode"]');
    modeRadios.forEach(radio => {
      radio.checked = radio.value === settings.mode;
    });
    
    document.getElementById('confirmBeforeDelete').checked = settings.confirmBeforeDelete;
    document.getElementById('showNotifications').checked = settings.showNotifications;
  }
  
  async saveSettings() {
    try {
      const settings = this.getSettingsFromUI();
      await browser.storage.sync.set({ settings });
      this.showStatus(t('settingssaved'), 'success');
    } catch (error) {
      console.error('Error saving settings:', error);
      this.showStatus(t('errorsavingsettings'), 'error');
    }
  }
  
  getSettingsFromUI() {
    const mode = document.querySelector('input[name="securityMode"]:checked')?.value || 'normal';
    const confirmBeforeDelete = document.getElementById('confirmBeforeDelete').checked;
    const showNotifications = document.getElementById('showNotifications').checked;
    
    return {
      mode,
      confirmBeforeDelete,
      showNotifications
    };
  }
  
  setupEventListeners() {
    const inputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    inputs.forEach(input => {
      input.addEventListener('change', () => {
        this.saveSettings();
      });
    });
    
    if (isPro) {
      document.getElementById('exportRules').addEventListener('click', () => {
        this.exportRules();
      });
      
      document.getElementById('importRules').addEventListener('click', () => {
        document.getElementById('importFileInput').click();
      });
      
      document.getElementById('importFileInput').addEventListener('change', (e) => {
        this.importRules(e.target.files[0]);
      });
      
      document.getElementById('clearAllRules').addEventListener('click', () => {
        this.clearAllRules();
      });
      
      document.getElementById('resetSettings').addEventListener('click', () => {
        this.resetSettings();
      });
    }
  }
  
  async loadStatistics() {
    try {
      const result = await browser.storage.sync.get(['rules', 'statistics']);
      const rules = result.rules || [];
      const stats = result.statistics || { totalBlocked: 0, blockedToday: 0 };
      
      document.getElementById('totalRules').textContent = rules.length;
      document.getElementById('totalBlocked').textContent = stats.totalBlocked || 0;
      document.getElementById('blockedToday').textContent = stats.blockedToday || 0;
    } catch (error) {
      console.error('Error loading statistics:', error);
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
      console.error('Error exporting rules:', error);
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
      
      await this.loadStatistics();
      this.showStatus(t('importedrules', `${importData.rules.length}`), 'success');
      
      document.getElementById('importFileInput').value = '';
      
      if (this.onRulesUpdated) {
        this.onRulesUpdated();
      }
      
      this.notifyOptionsReload();
    } catch (error) {
      console.error('Error importing rules:', error);
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
      await browser.storage.sync.set({ rules: [] });
      await this.loadStatistics();
      this.showStatus(t('allrulescleared'), 'success');
      
      if (this.onRulesUpdated) {
        this.onRulesUpdated();
      }
      this.notifyOptionsReload();
    } catch (error) {
      console.error('Error clearing rules:', error);
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
    } catch (error) {
      console.error('Error resetting settings:', error);
      this.showStatus(t('errorresettingsettings'), 'error');
    }
  }
  
  showStatus(message, type = 'success') {
    const statusElement = document.getElementById('statusMessage');
    statusElement.textContent = message;
    statusElement.className = `status-message ${type} show`;
    
    setTimeout(() => {
      statusElement.classList.remove('show');
    }, 3000);
  }
  
  notifyOptionsReload() {
    browser.runtime.sendMessage({
      type: 'reload_rules',
      excludeCurrentTab: true
    });
  }
}