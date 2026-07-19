import { normalizePathRule } from './normalizePathRule.js';
import { normalizePathSegment } from './normalizePathSegment.js';
import { isValidURL } from '../scripts/isValidURL.js';
import { isValidPathSegment } from '../scripts/isValidPathSegment.js';
import Logger from '../utils/logger.js';
import { isBlockedURL } from '../scripts/isBlockedURL.js';
import { getFocusSessionState } from '../utils/focusSession.js';

export class RulesManager {
  constructor() {
    this.logger = new Logger('RulesManager');
    this.defaultRedirectURL = browser.runtime.getURL("blocked.html");
    this.intermediaryRedirectURL = browser.runtime.getURL("redirect.html");
  }
  
  async getRules() {
    return new Promise((resolve) => {
      browser.storage.local.get('rules', ({ rules }) => {
        resolve(rules || []);
      });
    });
  }
  
  async saveRules(rules) {
    await new Promise((resolve) => {
      browser.storage.local.set({ rules }, resolve);
    });
    
    browser.runtime.sendMessage({
      type: 'reload_rules'
    });
  }
  
  validateRule(blockURL, redirectURL, schedule, category, isWhitelist = false) {
    const errors = [];
    
    if (!blockURL || blockURL.trim() === '') {
      errors.push('blockurl_empty');
    }
    
    if (isBlockedURL([{ url: blockURL }])) {
      errors.push('blockurl_restrict');
    }
    
    if (blockURL && !isValidPathSegment(blockURL)) {
      errors.push('blockurl_invalid');
    }
    
    if (!isWhitelist && redirectURL && !isValidURL(redirectURL)) {
      errors.push('redirect_invalid');
    }
    
    if (!isWhitelist && schedule) {
      if (!Array.isArray(schedule.days) || schedule.days.some(d => d < 0 || d > 6 || !Number.isInteger(d))) {
        errors.push('invalid_days');
      }
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.startTime) || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.endTime)) {
        errors.push('invalid_time_format');
      }
      const [startH, startM] = schedule.startTime.split(':').map(Number);
      const [endH, endM] = schedule.endTime.split(':').map(Number);
      if (startH * 60 + startM >= endH * 60 + endM) {
        errors.push('start_after_end');
      }
    }
    
    if (!isWhitelist && !category) {
      errors.push('category_required');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
  
  ruleExists(rules, blockURL, redirectURL, excludeIndex = -1, isWhitelist = false) {
    return rules.some((rule, index) => {
      if (excludeIndex !== -1 && index === excludeIndex) {
        return false;
      }
      
      const ruleIsWhitelist = rule.isWhitelist || false;
      if (ruleIsWhitelist !== isWhitelist) {
        return false;
      }
      
      if (isWhitelist) {
        return rule.blockURL === blockURL.trim();
      } else {
        return rule.blockURL === blockURL.trim() && rule.redirectURL === redirectURL.trim();
      }
    });
  }
  
  async createDNRRule(id, blockURL, redirectURL) {
    const trimmedBlock = blockURL.trim();
    const filter = normalizePathRule(trimmedBlock);
    const urlFilter = `||${filter}`;
    
    const normalizedBlockURL = normalizePathSegment(trimmedBlock);
    let action;
    
    if (redirectURL && redirectURL.trim() !== '') {
      const finalRedirectUrl = new URL(this.intermediaryRedirectURL);
      
      finalRedirectUrl.searchParams.set('from', normalizedBlockURL);
      
      try {
        const parsedRedirect = new URL(redirectURL.trim());
        finalRedirectUrl.searchParams.set('to', parsedRedirect.href);
      } catch (e) {
        finalRedirectUrl.searchParams.set('to', redirectURL.trim());
      }
      
      action = { type: "redirect", redirect: { url: finalRedirectUrl.href } };
    } else {
      const finalRedirectUrl = new URL(this.defaultRedirectURL);
      finalRedirectUrl.searchParams.set('url', normalizedBlockURL);
      action = { type: "redirect", redirect: { url: finalRedirectUrl.href } };
    }
    
    return {
      id: Math.floor(Number(id)),
      condition: { urlFilter, resourceTypes: ["main_frame"] },
      priority: 100,
      action
    };
  }
  
  async addRule(blockURL, redirectURL, schedule = null, category = 'social', isWhitelist = false) {
    const validation = this.validateRule(blockURL, redirectURL, schedule, category, isWhitelist);
    if (!validation.isValid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }
    
    const rules = await this.getRules();
    
    const conflict = this.checkConflict(rules, blockURL, isWhitelist);
    if (conflict) {
      throw new Error(conflict);
    }
    
    if (this.ruleExists(rules, blockURL, redirectURL, -1, isWhitelist)) {
      throw new Error('Rule already exists');
    }
    
    try {
      const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
      const occupiedIds = new Set([
        ...rules.map(r => Math.floor(Number(r.id))),
        ...dnrRules.map(r => r.id)
      ]);
      
      let safeId = 1;
      while (occupiedIds.has(safeId)) safeId++;
      
      const newRule = {
        id: safeId,
        blockURL: blockURL.trim(),
        redirectURL: isWhitelist ? '' : redirectURL.trim(),
        schedule: isWhitelist ? null : schedule,
        category: isWhitelist ? 'whitelist' : category,
        disabledByUser: false,
        isWhitelist: isWhitelist
      };
      
      rules.push(newRule);
      await this.saveRules(rules);
      
      return newRule;
    } catch (error) {
      throw new Error('Failed to add rule');
    }
  }
  
  async updateRule(index, newBlockURL, newRedirectURL, schedule = null, category, disabledByUser = null) {
    const rules = await this.getRules();
    const oldRule = rules[index];
    
    if (!oldRule) {
      throw new Error('Rule not found');
    }
    
    const isWhitelist = oldRule.isWhitelist || false;
    const validation = this.validateRule(newBlockURL, newRedirectURL, schedule, category, isWhitelist);
    if (!validation.isValid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }

    const conflict = this.checkConflict(rules, newBlockURL, isWhitelist, index);
    if (conflict) {
      throw new Error(conflict);
    }
    
    if (this.ruleExists(rules, newBlockURL, newRedirectURL, index, isWhitelist)) {
      throw new Error('Rule already exists');
    }
    
    let finalDisabledByUser = disabledByUser !== null ? disabledByUser : oldRule.disabledByUser || false;
    if (disabledByUser === null && !oldRule.schedule && schedule) {
      finalDisabledByUser = false;
    }
    
    try {
      rules[index] = {
        id: oldRule.id,
        blockURL: newBlockURL.trim(),
        redirectURL: isWhitelist ? '' : newRedirectURL.trim(),
        schedule: isWhitelist ? null : schedule,
        category: isWhitelist ? 'whitelist' : category,
        disabledByUser: finalDisabledByUser,
        isWhitelist: isWhitelist
      };
      
      await this.saveRules(rules);
      
      return rules[index];
    } catch (error) {
      throw new Error('Failed to update rule');
    }
  }
  
  async deleteRule(index) {
    const rules = await this.getRules();
    const ruleToDelete = rules[index];
    
    if (!ruleToDelete) {
      throw new Error('Rule not found');
    }
    
    try {
      rules.splice(index, 1);
      await this.saveRules(rules);
      
      return ruleToDelete;
    } catch (error) {
      throw new Error('Failed to delete rule');
    }
  }
  
  async deleteRuleByData(blockURL, redirectURL, isWhitelist = false) {
    const rules = await this.getRules();
    const index = rules.findIndex(rule =>
      rule.blockURL === blockURL.trim() &&
      (isWhitelist ? rule.isWhitelist === true : (!rule.isWhitelist && rule.redirectURL === redirectURL.trim()))
    );
    
    if (index === -1) {
      throw new Error('Rule not found');
    }
    
    return await this.deleteRule(index);
  }
  
  async deleteAllRules() {
    try {
      const activeRules = await browser.declarativeNetRequest.getDynamicRules();
      const ruleIdsToRemove = activeRules.map(rule => rule.id);
      
      if (ruleIdsToRemove.length > 0) {
        await browser.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: ruleIdsToRemove,
          addRules: []
        });
      }
      
      await this.saveRules([]);
    } catch (error) {
      this.logger.error("Delete all rules error:", error);
      throw new Error('Failed to delete all rules');
    }
  }
  
  async toggleRuleDisabled(index) {
    const rules = await this.getRules();
    if (!rules[index]) {
      throw new Error('Rule not found');
    }
    rules[index].disabledByUser = !rules[index].disabledByUser;
    await this.saveRules(rules);
    return rules[index];
  }
  
  async toggleCategoryDisabled(category) {
    const settings = await this.getSettings();
    let disabledCategories = settings.disabledCategories || [];
    
    if (disabledCategories.includes(category)) {
      disabledCategories = disabledCategories.filter(c => c !== category);
    } else {
      disabledCategories.push(category);
    }
    
    await browser.storage.sync.set({
      settings: { ...settings, disabledCategories }
    });
    
    browser.runtime.sendMessage({ type: 'reload_rules' });
  }
  
  async migrateRules() {
    const rules = await this.getRules();
    let needsFullMigration = false;
    let needsSave = false;
    
    const hasInvalidId = rules.some(r => !r.id || typeof r.id !== 'number' || r.id > 2000000000);
    const hasDuplicates = !hasInvalidId && new Set(rules.map(r => r.id)).size !== rules.length;
    const shouldResetAllIds = hasInvalidId || hasDuplicates;
    
    const migratedRules = rules.map((rule, i) => {
      const newRule = { ...rule };
      
      if (shouldResetAllIds) {
        newRule.id = i + 1;
        needsFullMigration = true;
        needsSave = true;
      }
      
      if (!rule.category) {
        newRule.category = rule.isWhitelist ? 'whitelist' : 'uncategorized';
        needsSave = true;
      }
      
      if (rule.disabledByUser === undefined) {
        newRule.disabledByUser = false;
        needsSave = true;
      }
      
      if (rule.isWhitelist === undefined) {
        newRule.isWhitelist = false;
        needsSave = true;
      }
      
      return newRule;
    });
    
    if (needsFullMigration) {
      await this.saveRules(migratedRules);
      return { migrated: true, rules: migratedRules };
    } else if (needsSave) {
      await this.saveRules(migratedRules);
      return { migrated: true, rules: migratedRules };
    }
    
    return { migrated: false, rules };
  }
  
  async getSettings() {
    return new Promise((resolve) => {
      browser.storage.sync.get(['settings'], ({ settings }) => {
        resolve(settings || {});
      });
    });
  }
  
  async isStrictMode() {
    const settings = await this.getSettings();
    return settings.mode === 'strict';
  }
  
  isRuleActiveNow(rule, disabledCategories = [], focusSessionActive = false) {
    if (rule.isWhitelist === true) return false;
    
    if (focusSessionActive) {
      return true;
    }
    if (rule.disabledByUser) return false;
    if (disabledCategories.includes(rule.category)) return false;
    if (!rule.schedule) return true;
    
    const now = new Date();
    const currentDay = now.getDay();
    if (!rule.schedule.days.includes(currentDay)) return false;
    
    const [startH, startM] = rule.schedule.startTime.split(':').map(Number);
    const [endH, endM] = rule.schedule.endTime.split(':').map(Number);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  
  async enableRulesByCategory(category) {
    const rules = await this.getRules();
    rules.forEach(rule => {
      if (rule.category === category && rule.disabledByUser) {
        rule.disabledByUser = false;
      }
    });
    await this.saveRules(rules);
  }
  
  async disableRulesByCategory(category) {
    const rules = await this.getRules();
    rules.forEach(rule => {
      if (rule.category === category) {
        rule.disabledByUser = true;
      }
    });
    await this.saveRules(rules);
  }
  
  async migrateRulesToLocalForDevice() {
    this.logger.log('Attempting device-specific rules migration from sync to local storage...');
    try {
      const localStatus = await browser.storage.local.get("is_migrated_to_local");
      
      if (!localStatus.is_migrated_to_local) {
        const syncData = await browser.storage.sync.get("rules");
        
        if (syncData.rules && Array.isArray(syncData.rules) && syncData.rules.length > 0) {
          this.logger.log(`Found ${syncData.rules.length} rules in sync storage. Migrating to local for this device.`);
          await browser.storage.local.set({ rules: syncData.rules });
          await browser.storage.local.set({ is_migrated_to_local: true });
          this.logger.log('Rules successfully migrated to local storage on this device.');
          
          await this.syncDnrRules();
          
          browser.runtime.sendMessage({
            type: 'reload_rules'
          });
          return true;
        } else {
          this.logger.log('No rules found in sync storage to migrate or rules are empty.');
          await browser.storage.local.set({ is_migrated_to_local: true });
        }
      } else {
        this.logger.log('Rules already migrated to local storage on this device. Skipping sync migration.');
      }
    } catch (error) {
      this.logger.error('Error during device-specific rules migration:', error);
    }
    return false;
  }
  
  checkConflict(rules, blockURL, isWhitelist, excludeIndex = -1) {
    const cleanNew = blockURL.trim().toLowerCase();
    
    for (let i = 0; i < rules.length; i++) {
      if (excludeIndex !== -1 && i === excludeIndex) continue;
      
      const rule = rules[i];
      const ruleIsWhitelist = rule.isWhitelist || false;
      const cleanExisting = rule.blockURL.trim().toLowerCase();
      
      if (ruleIsWhitelist !== isWhitelist) {
        if (cleanNew.includes(cleanExisting) || cleanExisting.includes(cleanNew)) {
          return isWhitelist ? 'conflict_blacklist' : 'conflict_whitelist';
        }
      } else if (isWhitelist) {
        if (cleanNew.includes(cleanExisting) || cleanExisting.includes(cleanNew)) {
          return 'redundant_whitelist';
        }
      }
    }
    
    return null;
  }
}