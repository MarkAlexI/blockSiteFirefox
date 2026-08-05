import { isValidURL } from '../scripts/isValidURL.js';
import { isValidPathSegment } from '../scripts/isValidPathSegment.js';
import { isBlockedURL } from '../scripts/isBlockedURL.js';

/**
 * Provides current rule storage and domain validation helpers.
 *
 * DNR generation, scheduling decisions, and legacy migrations live in their
 * own modules so they can be tested independently of browser storage.
 */
export class RulesManager {
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
      if (
        !Array.isArray(schedule.days) ||
        schedule.days.some(day =>
          day < 0 || day > 6 || !Number.isInteger(day)
        )
      ) {
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
