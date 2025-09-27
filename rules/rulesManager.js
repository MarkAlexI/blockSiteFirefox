import { normalizeUrlFilter } from '../scripts/normalizeUrlFilter.js';
import { isValidURL } from '../scripts/isValidURL.js';
import { isValidAscii } from '../scripts/isValidAscii.js';
import { isOnlyLowerCase } from '../scripts/isOnlyLowerCase.js';

export class RulesManager {
  constructor() {
    this.defaultRedirectURL = browser.runtime.getURL("blocked.html");
  }
  
  async getRules() {
    return new Promise((resolve) => {
      browser.storage.sync.get('rules', ({ rules }) => {
        resolve(rules || []);
      });
    });
  }
  
  async saveRules(rules) {
    browser.runtime.sendMessage({
      type: 'reload_rules'
    });
    
    return new Promise((resolve) => {
      browser.storage.sync.set({ rules }, resolve);
    });
  }
  
  validateRule(blockURL, redirectURL, schedule, category) {
    const errors = [];
    
    if (!blockURL || blockURL.trim() === '') {
      errors.push('blockurl_empty');
    }
    
    if (blockURL && !isValidAscii(blockURL)) {
      errors.push('blockurl_ascii');
    }
    
    if (blockURL && !isOnlyLowerCase(blockURL)) {
      errors.push('blockurl_lowercase');
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
  
  async createDNRRule(blockURL, redirectURL) {
    const dnrRules = await browser.declarativeNetRequest.getDynamicRules();
    const maxId = dnrRules.length ? Math.max(...dnrRules.map(r => r.id)) : 0;
    const newId = maxId + 1;
    
    const filter = normalizeUrlFilter(blockURL.trim());
    const urlFilter = `||${filter}`;
    const action = redirectURL.trim() ? { type: "redirect", redirect: { url: redirectURL.trim() } } : { type: "redirect", redirect: { url: this.defaultRedirectURL } };
    
    return {
      id: newId,
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
      const newDnrRule = await this.createDNRRule(blockURL, redirectURL);
      
      await browser.declarativeNetRequest.updateDynamicRules({
        addRules: [newDnrRule]
      });
      
      const newRule = {
        id: newDnrRule.id,
        blockURL: blockURL.trim(),
        redirectURL: redirectURL.trim(),
        schedule,
        category
      };
      
      rules.push(newRule);
      await this.saveRules(rules);
      
      return newRule;
    } catch (error) {
      console.info("DNR add error:", error);
      throw new Error('Failed to add rule');
    }
  }
  
  async updateRule(index, newBlockURL, newRedirectURL, schedule = null, category) {
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
    
    try {
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [oldRule.id]
      });
      
      const newDnrRule = await this.createDNRRule(newBlockURL, newRedirectURL);
      
      await browser.declarativeNetRequest.updateDynamicRules({
        addRules: [newDnrRule]
      });
      
      rules[index] = {
        id: newDnrRule.id,
        blockURL: newBlockURL.trim(),
        redirectURL: newRedirectURL.trim(),
        schedule,
        category
      };
      
      await this.saveRules(rules);
      
      return rules[index];
    } catch (error) {
      console.info("DNR update error:", error);
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
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleToDelete.id]
      });
      
      rules.splice(index, 1);
      await this.saveRules(rules);
      
      return ruleToDelete;
    } catch (error) {
      console.info("DNR remove error:", error);
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
  
  async migrateRules() {
    const rules = await this.getRules();
    let needsFullMigration = false;
    let needsSave = false;
    
    const migratedRules = rules.map((rule, i) => {
      const newRule = { ...rule };
      
      if (!rule.id) {
        needsFullMigration = true;
        needsSave = true;
      }
      
      if (!rule.category) {
        newRule.category = 'uncategorized';
        needsSave = true;
      }
      
      return newRule;
    });
    
    if (needsFullMigration) {
      try {
        const oldDnrRules = await browser.declarativeNetRequest.getDynamicRules();
        await browser.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: oldDnrRules.map(r => r.id)
        });
        
        const newDnrRules = migratedRules.map((rule, i) => {
          const filter = normalizeUrlFilter(rule.blockURL);
          const urlFilter = `||${filter}`;
          const action = rule.redirectURL ? { type: "redirect", redirect: { url: rule.redirectURL } } : { type: "redirect", redirect: { url: this.defaultRedirectURL } };
          
          return {
            id: i + 1,
            condition: { urlFilter, resourceTypes: ["main_frame"] },
            priority: 100,
            action
          };
        });
        
        await browser.declarativeNetRequest.updateDynamicRules({
          addRules: newDnrRules
        });
        
        const finalRules = newDnrRules.map((dnrRule, i) => ({
          id: dnrRule.id,
          blockURL: migratedRules[i].blockURL,
          redirectURL: migratedRules[i].redirectURL,
          schedule: migratedRules[i].schedule,
          category: migratedRules[i].category
        }));
        
        await this.saveRules(finalRules);
        
        return { migrated: true, rules: finalRules };
      } catch (error) {
        console.info("Migration error:", error);
        throw new Error('Failed to migrate rules');
      }
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
  
  isRuleActiveNow(rule) {
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
}