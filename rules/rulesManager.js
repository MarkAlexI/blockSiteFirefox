import { normalizePathRule } from './normalizePathRule.js';
import { normalizePathSegment } from './normalizePathSegment.js';
import { isValidURL } from '../scripts/isValidURL.js';
import { isValidPathSegment } from '../scripts/isValidPathSegment.js';
import Logger from '../utils/logger.js';
import { isBlockedURL } from '../scripts/isBlockedURL.js';

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
      
      const hasValidTimeFormat =
        /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.startTime) &&
        /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.endTime);
      
      if (!hasValidTimeFormat) {
        errors.push('invalid_time_format');
      } else {
        const [startH, startM] = schedule.startTime.split(':').map(Number);
        const [endH, endM] = schedule.endTime.split(':').map(Number);
        if (startH * 60 + startM >= endH * 60 + endM) {
          errors.push('start_after_end');
        }
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
  
  async migrateRulesToLocalForDevice() {
    this.logger.log(
      'Attempting device-specific rules migration from sync to local storage...'
    );
    
    try {
      const localData = await browser.storage.local.get([
        'rules',
        'is_migrated_to_local'
      ]);
      
      if (localData.is_migrated_to_local) {
        this.logger.log(
          'Rules already migrated to local storage on this device.'
        );
        return false;
      }
      
      const localRules = Array.isArray(localData.rules) ?
        localData.rules : [];
      
      if (localRules.length > 0) {
        await browser.storage.local.set({
          is_migrated_to_local: true
        });
        
        this.logger.log(
          'Local rules already exist. Preserving them and marking migration complete.'
        );
        
        return false;
      }
      
      const syncData = await browser.storage.sync.get('rules');
      const syncRules = Array.isArray(syncData.rules) ?
        syncData.rules : [];
      
      if (syncRules.length > 0) {
        await browser.storage.local.set({
          rules: syncRules,
          is_migrated_to_local: true
        });
        
        this.logger.log(
          `Successfully migrated ${syncRules.length} rules to local storage.`
        );
        
        return true;
      }
      
      await browser.storage.local.set({
        is_migrated_to_local: true
      });
      
      this.logger.log('No sync rules found to migrate.');
    } catch (error) {
      this.logger.error(
        'Error during device-specific rules migration:',
        error
      );
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