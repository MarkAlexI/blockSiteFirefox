import { findBestMatchingRule } from './urlRuleMatcher.js';
import {
  getAssignmentUsageKey,
  getRuleAssignment,
  parseAssignmentUsageKey
} from './ruleAssignments.js';
import { getDailyLimitSeconds } from './blockingMode.js';
import { getTrackableDailyLimitAssignments } from './ruleActivation.js';

function isIntegerWindowId(value) {
  return Number.isInteger(value);
}

export function createDailyLimitTracker({
  tabsApi,
  windowsApi,
  getRules,
  getSettings,
  getRuleLists,
  getFocusSessionState,
  dailyLimitManager,
  dnrSynchronizer,
  logger
}) {
  let samplePromise = null;
  let sampleRequestedAgain = false;
  let lastKnownFocusedWindowId = null;
  const WINDOW_ID_NONE = Number.isInteger(windowsApi?.WINDOW_ID_NONE)
    ? windowsApi.WINDOW_ID_NONE
    : -1;

  let debugState = {
    lastReason: null,
    lastSampleAt: null,
    resolution: 'not_sampled',
    activeRuleId: null,
    activeAssignmentListIds: [],
    tabId: null,
    windowId: null,
    focusSource: null,
    addedSeconds: 0,
    currentUsageSeconds: 0,
    errorName: null
  };

  function noteWindowFocus(windowId) {
    lastKnownFocusedWindowId = isIntegerWindowId(windowId) ? windowId : null;
  }

  async function resolveWindowFocus(windowId) {
    if (!isIntegerWindowId(windowId)) {
      return { focused: false, source: 'missing_window_id' };
    }

    if (lastKnownFocusedWindowId === WINDOW_ID_NONE) {
      return { focused: false, source: 'focus_event_none' };
    }

    if (lastKnownFocusedWindowId === windowId) {
      return { focused: true, source: 'focus_event' };
    }

    if (typeof windowsApi?.get === 'function') {
      try {
        const windowInfo = await windowsApi.get(windowId);
        if (typeof windowInfo?.focused === 'boolean') {
          return { focused: windowInfo.focused, source: 'windows_get' };
        }
      } catch (error) {
        logger?.info?.('Daily limit windows.get focus check failed:', error);
      }
    }

    if (typeof windowsApi?.getLastFocused === 'function') {
      try {
        const windowInfo = await windowsApi.getLastFocused();
        if (typeof windowInfo?.focused === 'boolean') {
          const sameWindow = !isIntegerWindowId(windowInfo.id) || windowInfo.id === windowId;
          return {
            focused: windowInfo.focused === true && sameWindow,
            source: 'windows_get_last_focused'
          };
        }
      } catch (error) {
        logger?.info?.('Daily limit getLastFocused focus check failed:', error);
      }
    }

    if (typeof windowsApi?.getAll === 'function') {
      try {
        const windows = await windowsApi.getAll();
        if (Array.isArray(windows)) {
          const focusedWindow = windows.find(windowInfo => windowInfo?.focused === true);
          return {
            focused: Boolean(focusedWindow && focusedWindow.id === windowId),
            source: 'windows_get_all'
          };
        }
      } catch (error) {
        logger?.info?.('Daily limit getAll focus check failed:', error);
      }
    }

    return { focused: false, source: 'focus_unknown' };
  }

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

  async function resolveActiveDailyLimitContext(tabHint = null) {
    const tab = await resolveCandidateTab(tabHint);
    if (!tab) {
      return {
        rule: null,
        assignments: [],
        tab: null,
        status: 'no_active_tab',
        focusSource: null
      };
    }

    const focus = await resolveWindowFocus(tab.windowId);
    if (!focus.focused) {
      return {
        rule: null,
        assignments: [],
        tab,
        status: 'browser_not_focused',
        focusSource: focus.source
      };
    }

    const [rules, settings, lists, focusState, usageSeconds] = await Promise.all([
      getRules(),
      getSettings(),
      getRuleLists(),
      getFocusSessionState(),
      dailyLimitManager.getUsageSeconds()
    ]);

    if (focusState?.focusActive) {
      return {
        rule: null,
        assignments: [],
        tab,
        status: 'focus_session_active',
        focusSource: focus.source
      };
    }

    const disabledCategories = new Set(settings?.disabledCategories || []);
    const disabledLists = new Set((lists || []).filter(list => list?.disabled).map(list => list.id));
    const assignmentsByRuleId = new Map();

    const eligibleRules = (rules || []).filter(rule => {
      if (
        rule?.isWhitelist === true ||
        rule?.disabledByUser === true ||
        disabledCategories.has(rule.category)
      ) {
        return false;
      }

      const assignments = getTrackableDailyLimitAssignments(
        rule,
        disabledLists,
        new Date(),
        usageSeconds
      );
      if (assignments.length === 0) return false;
      assignmentsByRuleId.set(Number(rule.id), assignments);
      return true;
    });

    const rule = findBestMatchingRule(tab.url, eligibleRules);
    const assignments = rule ? (assignmentsByRuleId.get(Number(rule.id)) || []) : [];
    return {
      rule,
      assignments,
      tab,
      status: rule ? 'matched' : 'no_matching_rule',
      focusSource: focus.source
    };
  }

  async function resolveActiveDailyLimitRule(tabHint = null) {
    const context = await resolveActiveDailyLimitContext(tabHint);
    return context.rule;
  }

  async function sampleOnce(reason = 'event', now = new Date(), tabHint = null) {
    let context = {
      rule: null,
      assignments: [],
      tab: null,
      status: 'resolution_error',
      focusSource: null
    };
    let errorName = null;

    try {
      context = await resolveActiveDailyLimitContext(tabHint);
    } catch (error) {
      errorName = error?.name || 'Error';
      logger?.info?.(`Daily limit sampling could not resolve active tab (${reason}):`, error);
    }

    const activeKeys = context.rule
      ? context.assignments
          .map(item => getAssignmentUsageKey(context.rule.id, item.listId))
          .filter(Boolean)
      : [];
    const result = await dailyLimitManager.recordSample(activeKeys, now);

    let crossedLimit = false;
    for (const [key, update] of Object.entries(result.usageUpdates || {})) {
      const parsed = parseAssignmentUsageKey(key);
      if (!parsed) continue;
      const rules = await getRules();
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
      focusSource: context.focusSource || null,
      addedSeconds: Number(result.addedSeconds) || 0,
      currentUsageSeconds,
      errorName
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
    noteWindowFocus,
    resolveActiveDailyLimitRule,
    getDebugState
  };
}
