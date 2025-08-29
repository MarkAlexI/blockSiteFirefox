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
    return new Promise((resolve) => {
      browser.storage.sync.set({ rules }, resolve);
    });
  }
  
  validateRule(blockURL, redirectURL) {
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
    const action = redirectURL.trim() ?
      { type: "redirect", redirect: { url: redirectURL.trim() } } :
      { type: "redirect", redirect: { url: this.defaultRedirectURL } };
    
    return {
      id: newId,
      condition: { urlFilter, resourceTypes: ["main_frame"] },
      priority: 100,
      action
    };
  }
  
  async addRule(blockURL, redirectURL) {
    const validation = this.validateRule(blockURL, redirectURL);
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
        redirectURL: redirectURL.trim()
      };
      
      rules.push(newRule);
      await this.saveRules(rules);
      
      return newRule;
    } catch (error) {
      console.error("DNR add error:", error);
      throw new Error('Failed to add rule');
    }
  }
  
  async updateRule(index, newBlockURL, newRedirectURL) {
    const validation = this.validateRule(newBlockURL, newRedirectURL);
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
        redirectURL: newRedirectURL.trim()
      };
      
      await this.saveRules(rules);
      
      return rules[index];
    } catch (error) {
      console.error("DNR update error:", error);
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
      console.error("DNR remove error:", error);
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

    if (!rules.some(rule => !rule.id)) {
      return { migrated: false, rules };
    }
    
    try {
      const oldDnrRules = await browser.declarativeNetRequest.getDynamicRules();
      await browser.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: oldDnrRules.map(r => r.id)
      });

      const newDnrRules = rules.map((rule, i) => {
        const filter = normalizeUrlFilter(rule.blockURL);
        const urlFilter = `||${filter}`;
        const action = rule.redirectURL ?
          { type: "redirect", redirect: { url: rule.redirectURL } } :
          { type: "redirect", redirect: { url: this.defaultRedirectURL } };
        
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

      const migratedRules = newDnrRules.map((dnrRule, i) => ({
        id: dnrRule.id,
        blockURL: rules[i].blockURL,
        redirectURL: rules[i].redirectURL
      }));
      
      await this.saveRules(migratedRules);
      
      return { migrated: true, rules: migratedRules };
    } catch (error) {
      console.error("Migration error:", error);
      throw new Error('Failed to migrate rules');
    }
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
}