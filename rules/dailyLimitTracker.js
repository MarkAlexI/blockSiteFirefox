import { findBestMatchingRule } from './urlRuleMatcher.js';
import {
  getAssignmentUsageKey,
  getRuleAssignment,
  parseAssignmentUsageKey
} from './ruleAssignments.js';
import { getDailyLimitSeconds } from './blockingMode.js';
import { getTrackableDailyLimitAssignments } from './ruleActivation.js';

function normalizeVisibilityProbeResult(results) {
  if (!Array.isArray(results)) return null;
  for (const item of results) {
    const result = item?.result;
    if (!result || typeof result !== 'object') continue;
    const visibilityState = typeof result.visibilityState === 'string'
      ? result.visibilityState
      : null;
    const hidden = typeof result.hidden === 'boolean' ? result.hidden : null;
    const hasFocus = typeof result.hasFocus === 'boolean' ? result.hasFocus : null;
    if (visibilityState || hidden !== null || hasFocus !== null) {
      return { visibilityState, hidden, hasFocus };
    }
  }
  return null;
}

export function createDailyLimitTracker({
  tabsApi,
  scriptingApi,
  getRules,
  getRuleListState,
  getFocusSessionState,
  dailyLimitManager,
  dnrSynchronizer,
  logger
}) {
  let samplePromise = null;
  let sampleRequestedAgain = false;

  let debugState = {
    lastReason: null,
    lastSampleAt: null,
    resolution: 'not_sampled',
    activeRuleId: null,
    activeAssignmentListIds: [],
    tabId: null,
    windowId: null,
    visibilityState: null,
    visibilitySource: null,
    documentHasFocus: null,
    addedSeconds: 0,
    currentUsageSeconds: 0,
    errorName: null
  };

  async function resolveCandidateTab(tabHint = null) {
    if (tabHint?.active === true && tabHint?.url) {
      return tabHint;
    }

    const tabs = await tabsApi.query({
      active: true,
      lastFocusedWindow: true
    });

    return Array.isArray(tabs)
      ? (tabs.find(tab => tab?.active === true && tab?.url) || null)
      : null;
  }

  async function probePageVisibility(tab) {
    if (!Number.isInteger(tab?.id)) {
      return {
        visible: false,
        status: 'visibility_probe_unavailable',
        visibilityState: null,
        visibilitySource: 'missing_tab_id',
        documentHasFocus: null,
        errorName: null
      };
    }

    if (typeof scriptingApi?.executeScript !== 'function') {
      return {
        visible: false,
        status: 'visibility_probe_unavailable',
        visibilityState: null,
        visibilitySource: 'scripting_unavailable',
        documentHasFocus: null,
        errorName: null
      };
    }

    try {
      const results = await scriptingApi.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          visibilityState: document.visibilityState,
          hidden: document.hidden === true,
          hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null
        })
      });
      const probe = normalizeVisibilityProbeResult(results);
      if (!probe || typeof probe.visibilityState !== 'string') {
        return {
          visible: false,
          status: 'visibility_probe_failed',
          visibilityState: null,
          visibilitySource: 'document_visibility',
          documentHasFocus: probe?.hasFocus ?? null,
          errorName: 'NoVisibilityResult'
        };
      }

      const visible = probe.visibilityState === 'visible' && probe.hidden !== true;
      return {
        visible,
        status: visible ? 'visible' : 'page_hidden',
        visibilityState: probe.visibilityState,
        visibilitySource: 'document_visibility',
        documentHasFocus: probe.hasFocus,
        errorName: null
      };
    } catch (error) {
      logger?.info?.('Daily limit page visibility probe failed:', error);
      return {
        visible: false,
        status: 'visibility_probe_failed',
        visibilityState: null,
        visibilitySource: 'scripting_execute_script',
        documentHasFocus: null,
        errorName: error?.name || 'Error'
      };
    }
  }

  async function resolveActiveDailyLimitContext(tabHint = null) {
    const tab = await resolveCandidateTab(tabHint);
    if (!tab) {
      return {
        rule: null,
        assignments: [],
        tab: null,
        status: 'no_active_tab',
        visibilityState: null,
        visibilitySource: null,
        documentHasFocus: null,
        errorName: null
      };
    }

    const [rules, ruleListState, focusState, usageSeconds] = await Promise.all([
      getRules(),
      getRuleListState(),
      getFocusSessionState(),
      dailyLimitManager.getUsageSeconds()
    ]);

    if (focusState?.focusActive) {
      return {
        rule: null,
        assignments: [],
        tab,
        status: 'focus_session_active',
        visibilityState: null,
        visibilitySource: null,
        documentHasFocus: null,
        errorName: null
      };
    }

    const activeRuleListId = ruleListState?.activeRuleListId || 'general';
    const activeProfile = (ruleListState?.lists || []).find(list => list?.id === activeRuleListId);
    const disabledCategories = new Set(activeProfile?.disabledCategories || []);
    const assignmentsByRuleId = new Map();

    const eligibleRules = (rules || []).filter(rule => {
      if (
        rule?.isWhitelist === true ||
        disabledCategories.has(rule.category)
      ) {
        return false;
      }

      const assignments = getTrackableDailyLimitAssignments(
        rule,
        activeRuleListId,
        new Date(),
        usageSeconds
      );
      if (assignments.length === 0) return false;
      assignmentsByRuleId.set(Number(rule.id), assignments);
      return true;
    });

    const rule = findBestMatchingRule(tab.url, eligibleRules);
    if (!rule) {
      return {
        rule: null,
        assignments: [],
        tab,
        status: 'no_matching_rule',
        visibilityState: null,
        visibilitySource: null,
        documentHasFocus: null,
        errorName: null
      };
    }

    const assignments = assignmentsByRuleId.get(Number(rule.id)) || [];
    const visibility = await probePageVisibility(tab);
    return {
      rule,
      assignments,
      tab,
      status: visibility.visible ? 'matched' : visibility.status,
      visibilityState: visibility.visibilityState,
      visibilitySource: visibility.visibilitySource,
      documentHasFocus: visibility.documentHasFocus,
      errorName: visibility.errorName
    };
  }

  async function resolveActiveDailyLimitRule(tabHint = null) {
    const context = await resolveActiveDailyLimitContext(tabHint);
    return context.status === 'matched' ? context.rule : null;
  }

  async function sampleOnce(reason = 'event', now = new Date(), tabHint = null) {
    let context = {
      rule: null,
      assignments: [],
      tab: null,
      status: 'resolution_error',
      visibilityState: null,
      visibilitySource: null,
      documentHasFocus: null,
      errorName: null
    };

    try {
      context = await resolveActiveDailyLimitContext(tabHint);
    } catch (error) {
      context.errorName = error?.name || 'Error';
      logger?.info?.(`Daily limit sampling could not resolve active tab (${reason}):`, error);
    }

    const activeKeys = context.status === 'matched' && context.rule
      ? context.assignments
          .map(item => getAssignmentUsageKey(context.rule.id, item.listId))
          .filter(Boolean)
      : [];
    const result = await dailyLimitManager.recordSample(activeKeys, now);

    let crossedLimit = false;
    const rules = Object.keys(result.usageUpdates || {}).length > 0 ? await getRules() : [];
    for (const [key, update] of Object.entries(result.usageUpdates || {})) {
      const parsed = parseAssignmentUsageKey(key);
      if (!parsed) continue;
      const accountedRule = rules.find(rule => Number(rule.id) === parsed.ruleId);
      const assignment = accountedRule ? getRuleAssignment(accountedRule, parsed.listId) : null;
      const limitSeconds = assignment ? getDailyLimitSeconds(assignment) : null;
      if (
        limitSeconds !== null &&
        update.previousUsageSeconds < limitSeconds &&
        update.currentUsageSeconds >= limitSeconds
      ) {
        crossedLimit = true;
        logger?.log?.(`Daily limit reached for rule ${parsed.ruleId} in list ${parsed.listId}`);
      }
    }

    if (crossedLimit) {
      await dnrSynchronizer.requestSync();
    }

    const currentUsageSeconds = Math.max(
      0,
      ...Object.values(result.usageUpdates || {}).map(item => Number(item.currentUsageSeconds) || 0)
    );
    debugState = {
      lastReason: reason,
      lastSampleAt: now.toISOString(),
      resolution: context.status,
      activeRuleId: context.rule?.id ?? null,
      activeAssignmentListIds: context.assignments.map(item => item.listId),
      tabId: Number.isInteger(context.tab?.id) ? context.tab.id : null,
      windowId: Number.isInteger(context.tab?.windowId) ? context.tab.windowId : null,
      visibilityState: context.visibilityState,
      visibilitySource: context.visibilitySource,
      documentHasFocus: context.documentHasFocus,
      addedSeconds: Number(result.addedSeconds) || 0,
      currentUsageSeconds,
      errorName: context.errorName
    };

    return {
      ...result,
      resolution: context.status,
      activeRuleId: context.rule?.id ?? null,
      activeAssignmentListIds: context.assignments.map(item => item.listId)
    };
  }

  async function runSampleLoop(reason, now, tabHint) {
    let result;
    let nextTabHint = tabHint;
    do {
      sampleRequestedAgain = false;
      result = await sampleOnce(reason, now, nextTabHint);
      now = new Date();
      nextTabHint = null;
    } while (sampleRequestedAgain);
    return result;
  }

  function sample(reason = 'event', now = new Date(), tabHint = null) {
    if (samplePromise) {
      sampleRequestedAgain = true;
      return samplePromise;
    }
    samplePromise = runSampleLoop(reason, now, tabHint).finally(() => {
      samplePromise = null;
      if (sampleRequestedAgain) return sample(reason);
    });
    return samplePromise;
  }

  function getDebugState() {
    return { ...debugState };
  }

  return {
    sample,
    resolveActiveDailyLimitRule,
    getDebugState
  };
}
