import { isValidURL } from '../scripts/isValidURL.js';
import { isValidPathSegment } from '../scripts/isValidPathSegment.js';
import { isBlockedURL } from '../scripts/isBlockedURL.js';
import { validateSchedule } from '../schedules/scheduleValidator.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_SCHEDULE,
  validateBlockingConfig
} from './blockingMode.js';

/**
 * Provides current rule storage and domain validation helpers.
 *
 * DNR generation, scheduling decisions, and legacy migrations live in their
 * own modules so they can be tested independently of browser storage.
 */
export class RulesManager {
  async getRules() {
    return new Promise((resolve) => {
      chrome.storage.local.get('rules', ({ rules }) => {
        resolve(rules || []);
      });
    });
  }

  async saveRules(rules) {
    await new Promise((resolve) => {
      chrome.storage.local.set({ rules }, resolve);
    });
  }

  validateRule(
    blockURL,
    redirectURL,
    schedule,
    category,
    isWhitelist = false,
    blockingMode = null,
    dailyLimit = null
  ) {
    const errors = [];
    const effectiveBlockingMode = isWhitelist ?
      BLOCKING_MODE_ALWAYS :
      (blockingMode || (schedule ? BLOCKING_MODE_SCHEDULE : BLOCKING_MODE_ALWAYS));

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

    if (!isWhitelist) {
      const blockingValidation = validateBlockingConfig({
        blockingMode: effectiveBlockingMode,
        schedule,
        dailyLimit,
        isWhitelist
      });
      errors.push(...blockingValidation.errors);

      if (effectiveBlockingMode === BLOCKING_MODE_SCHEDULE && schedule) {
        const scheduleValidation = validateSchedule(schedule);
        errors.push(...scheduleValidation.errors);
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

  ruleExists(
    rules,
    blockURL,
    redirectURL,
    excludeIndex = -1,
    isWhitelist = false
  ) {
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
      }

      return rule.blockURL === blockURL.trim() &&
        rule.redirectURL === redirectURL.trim();
    });
  }

  checkConflict(rules, blockURL, isWhitelist, excludeIndex = -1) {
    const cleanNew = blockURL.trim().toLowerCase();

    for (let index = 0; index < rules.length; index++) {
      if (excludeIndex !== -1 && index === excludeIndex) continue;

      const rule = rules[index];
      const ruleIsWhitelist = rule.isWhitelist || false;
      const cleanExisting = rule.blockURL.trim().toLowerCase();

      if (ruleIsWhitelist !== isWhitelist) {
        if (
          cleanNew.includes(cleanExisting) ||
          cleanExisting.includes(cleanNew)
        ) {
          return isWhitelist ? 'conflict_blacklist' : 'conflict_whitelist';
        }
      } else if (isWhitelist) {
        if (
          cleanNew.includes(cleanExisting) ||
          cleanExisting.includes(cleanNew)
        ) {
          return 'redundant_whitelist';
        }
      }
    }

    return null;
  }
}
