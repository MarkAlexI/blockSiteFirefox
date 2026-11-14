import { isValidURL } from '../scripts/isValidURL.js';
import { isValidPathSegment } from '../scripts/isValidPathSegment.js';
import { createDnrUrlFilter, getBlacklistTargetKey, InvalidDnrUrlFilterError } from './dnrRuleFactory.js';
import { normalizeWhitelistTarget, isValidWhitelistTarget, getWhitelistTargetKey,
  areWhitelistTargetsRedundant, matchesWhitelistHostname, matchesWhitelistTarget } from '../pro/isUrlInWhitelist.js';
import { doesUrlMatchBlockRule } from './urlRuleMatcher.js';
import {
  hasUnsupportedExplicitScheme,
  isBlockedURL
} from '../scripts/isBlockedURL.js';
import { validateSchedule } from '../schedules/scheduleValidator.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_SCHEDULE,
  validateBlockingConfig
} from './blockingMode.js';

/** Check the explicit host/path scopes named by the two rules. Do not treat
 * text in a query, fragment or unrelated path as a hostname. This preserves
 * the existing partial-target policy rather than inventing hostnames by
 * concatenating unrelated fragments or adding arbitrary new subdomains.
 */
function hasBlacklistWhitelistConflict(blockURL, whitelist) {
  const key = getBlacklistTargetKey(blockURL);
  if (!key || !whitelist) return false;
  const filter = key.slice(2);
  let parsed;
  try { parsed = new URL(`https://${filter}`); } catch { /* Advanced DNR syntax may not be a URL. */ }

  if (parsed) {
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    const hosts = new Set([parsed.hostname, whitelist.hostname]);
    const paths = new Set([path || '/', whitelist.path || '/']);
    const port = parsed.port ? `:${parsed.port}` : '';
    for (const hostname of hosts) for (const pathname of paths) {
      let url;
      try {
        url = new URL(`https://${hostname}${port}${pathname}`);
      } catch { continue; /* A literal filter token need not form a request URL. */ }
      if (matchesWhitelistTarget(url, whitelist) && doesUrlMatchBlockRule(url.href, blockURL)) return true;
    }
    if (!/[*^|]/.test(filter)) return false;

    // Path operators cannot make an unrelated literal hostname match. Keep
    // the legacy advanced-pattern check only when the explicit hosts overlap.
    if (path && !/[*^|]/.test(parsed.hostname)) {
      const hostOverlap = [...hosts].some(hostname => matchesWhitelistHostname(hostname, whitelist)
        && (hostname === parsed.hostname || hostname.endsWith(`.${parsed.hostname}`)));
      if (!hostOverlap) return false;
    }
  }

  // Preserve the existing checks for advanced filter syntax. Its tokens are
  // not parsed as Whitelist operators or expanded into a different grammar.
  const allowed = whitelist.hostname + whitelist.path;
  return filter.includes(allowed) || allowed.includes(filter);
}

/**
 * Provides current rule storage and domain validation helpers.
 *
 * DNR generation, scheduling decisions, and legacy migrations live in their
 * own modules so they can be tested independently of browser storage.
 */
export class RulesManager {
  async getRules() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get('rules', (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message || 'Could not load rules from local storage'));
          return;
        }
        const { rules } = result || {};
        resolve(rules || []);
      });
    });
  }

  async getRulesSnapshot() {
    return new Promise((resolve, reject) => {
      // Read IDs, bulk generation and per-rule revisions from one storage snapshot.
      chrome.storage.local.get(['rules', 'rulesGeneration', 'ruleRevisions'], result => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message || 'Could not load rules from local storage'));
          return;
        }
        resolve({ rules: result?.rules || [], generation: result?.rulesGeneration ?? null, revisions: result?.ruleRevisions || {} });
      });
    });
  }

  async prepareRulesState(rules, extraState = {}) {
    // All production rule writers join the worker's existing mutation queue.
    // Persist revisions with the rules so no view can observe half a commit.
    const previous = await this.getRulesSnapshot();
    const previousRules = new Map(previous.rules.map(rule => [rule.id, rule]));
    const ruleRevisions = {};
    for (const rule of rules) {
      const oldRule = previousRules.get(rule.id);
      ruleRevisions[rule.id] = oldRule && JSON.stringify(oldRule) === JSON.stringify(rule)
        ? (previous.revisions[rule.id] ?? null)
        : Array.from(crypto.getRandomValues(new Uint8Array(16)),
            byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return { rules, ruleRevisions, ...extraState };
  }

  async saveRules(rules, extraState = {}) {
    const patch = await this.prepareRulesState(rules, extraState);
    await new Promise((resolve, reject) => {
      const request = chrome.storage.local.set(patch, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message || 'Could not save rules to local storage'));
          return;
        }
        resolve();
      });
      request?.catch(reject);
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

    if (
      hasUnsupportedExplicitScheme(blockURL) ||
      (!isWhitelist && isBlockedURL([{ url: blockURL }]))
    ) {
      errors.push('blockurl_restrict');
    }

    if (blockURL && !isValidPathSegment(blockURL)) {
      errors.push('blockurl_invalid');
    } else if (isWhitelist && blockURL?.trim() && !hasUnsupportedExplicitScheme(blockURL)
        && !isValidWhitelistTarget(blockURL)) {
      errors.push('blockurl_invalid');
    } else if (!isWhitelist && blockURL?.trim()) {
      try {
        createDnrUrlFilter(blockURL);
      } catch (error) {
        if (!(error instanceof InvalidDnrUrlFilterError)) throw error;
        errors.push('blockurl_invalid');
      }
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
        const key = getWhitelistTargetKey(blockURL);
        return key !== null && getWhitelistTargetKey(rule.blockURL) === key;
      }

      return rule.blockURL === blockURL.trim() &&
        rule.redirectURL === redirectURL.trim();
    });
  }

  checkConflict(rules, blockURL, isWhitelist, excludeIndex = -1) {
    const newWhitelist = isWhitelist ? normalizeWhitelistTarget(blockURL) : null;

    for (let index = 0; index < rules.length; index++) {
      if (excludeIndex !== -1 && index === excludeIndex) continue;

      const rule = rules[index];
      if (typeof rule.blockURL !== 'string') continue;
      const ruleIsWhitelist = rule.isWhitelist || false;
      if (ruleIsWhitelist !== isWhitelist) {
        const whitelist = isWhitelist ? newWhitelist : normalizeWhitelistTarget(rule.blockURL);
        const blacklist = isWhitelist ? rule.blockURL : blockURL;
        if (hasBlacklistWhitelistConflict(blacklist, whitelist)) {
          return isWhitelist ? 'conflict_blacklist' : 'conflict_whitelist';
        }
      } else if (isWhitelist) {
        if (areWhitelistTargetsRedundant(newWhitelist, normalizeWhitelistTarget(rule.blockURL))) {
          return 'redundant_whitelist';
        }
      }
    }

    return null;
  }
}
