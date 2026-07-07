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
      browser.storage.sync.get('rules', ({ rules }) => {
        resolve(rules || []);
      });
    });
  }
  
  async saveRules(rules) {
    await new Promise((resolve) => {
      browser.storage.sync.set({ rules }, resolve);
    });
    await this.syncDnrRules();
    
    browser.runtime.sendMessage({
      type: 'reload_rules'
    });
  }
  
  async syncDnrRules() {
    try {
      const rules = await this.getRules();
      const settings = await this.getSettings();
      const disabledCategories = settings.disabledCategories || [];
      const { focusActive } = await getFocusSessionState();
      
      const currentDnrRules = await browser.declarativeNetRequest.getDynamicRules();
      const currentDnrIds = currentDnrRules.map(r => r.id);
      
      const activeRules = rules.filter(rule => this.isRuleActiveNow(rule, disabledCategories, focusActive));
      const addRules = [];
      const seenIds = new Set();
      
      for (const rule of activeRules) {
        const id = Math.floor(Number(rule.id));
        if (id > 0 && !seenIds.has(id)) {
          const dnrRule = await this.createDNRRule(id, rule.blockURL, rule.redirectURL);
          addRules.push(dnrRule);
          seenIds.add(id);
        }
        
        if (!rule.disabledByUser) {
          browser.runtime.sendMessage({
            type: 'CLOSE_MATCHING_TABS',
            url: rule.blockURL
          });
        }
      }
      
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: currentDnrIds,
        addRules: addRules
      });
      
      this.logger.log(`DNR Synced: ${addRules.length} rules active.`);
    } catch (error) {
      this.logger.error("DNR Sync error:", error);
    }
  }
  
  validateRule(blockURL, redirectURL, schedule, category) {
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
    
    if (redirectURL && !isValidURL(redirectURL)) {
      errors.push('redirect_invalid');
    }
    
    if (schedule) {
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
    
    if (!category) {
      errors.push('category_required');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
  
  ruleExists(rules, blockURL, redirectURL, excludeIndex = -1) {
    return rules.some((rule, index) => {
      if (excludeIndex !== -1 && index === excludeIndex) {
        return false;
      }
      return rule.blockURL === blockURL.trim() && rule.redirectURL === redirectURL.trim();
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
  
  async addRule(blockURL, redirectURL, schedule = null, category = 'social') {
    const validation = this.validateRule(blockURL, redirectURL, schedule, category);
    if (!validation.isValid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }
    
    const rules = await this.getRules();
    
    if (this.ruleExists(rules, blockURL, redirectURL)) {
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
        redirectURL: redirectURL.trim(),
        schedule,
        category,
        disabledByUser: false
      };
      
      rules.push(newRule);
      await this.saveRules(rules);
      
      return newRule;
    } catch (error) {
      throw new Error('Failed to add rule');
    }
  }
  
  async updateRule(index, newBlockURL, newRedirectURL, schedule = null, category, disabledByUser = null) {
    const validation = this.validateRule(newBlockURL, newRedirectURL, schedule, category);
    if (!validation.isValid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }
    
    const rules = await this.getRules();
    const oldRule = rules[index];
    
    if (!oldRule) {
      throw new Error('Rule not found');
    }
    
    if (this.ruleExists(rules, newBlockURL, newRedirectURL, index)) {
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
        redirectURL: newRedirectURL.trim(),
        schedule,
        category,
        disabledByUser: finalDisabledByUser
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
  
  async deleteRuleByData(blockURL, redirectURL) {
    const rules = await this.getRules();
    const index = rules.findIndex(rule =>
      rule.blockURL === blockURL.trim() && rule.redirectURL === redirectURL.trim()
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
    await this.syncDnrRules();
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
        newRule.category = 'uncategorized';
        needsSave = true;
      }
      
      if (rule.disabledByUser === undefined) {
        newRule.disabledByUser = false;
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
}