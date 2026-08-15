import { BLOCKING_MODE_DAILY_LIMIT, getRuleBlockingMode, getDailyLimitSeconds } from './blockingMode.js';
import { findBestMatchingRule } from './urlRuleMatcher.js';
import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';

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

  async function getFocusedActiveTab() {
    const windowInfo = await windowsApi.getLastFocused();
    if (!windowInfo || windowInfo.focused !== true || !Number.isInteger(windowInfo.id)) return null;

    const tabs = await tabsApi.query({
      active: true,
      windowId: windowInfo.id
    });
    return Array.isArray(tabs) ? (tabs.find(tab => tab?.active === true) || null) : null;
  }

  async function resolveActiveDailyLimitRule() {
    const tab = await getFocusedActiveTab();
    if (!tab?.url) return null;

    const [rules, settings, lists, focusState] = await Promise.all([
      getRules(),
      getSettings(),
      getRuleLists(),
      getFocusSessionState()
    ]);

    if (focusState?.focusActive) return null;

    const disabledCategories = new Set(settings?.disabledCategories || []);
    const disabledLists = new Set((lists || []).filter(list => list?.disabled).map(list => list.id));

    const eligible = (rules || []).filter(rule =>
      rule?.isWhitelist !== true &&
      rule?.disabledByUser !== true &&
      !disabledCategories.has(rule.category) &&
      !disabledLists.has(rule.listId || GENERAL_RULE_LIST_ID) &&
      getRuleBlockingMode(rule) === BLOCKING_MODE_DAILY_LIMIT &&
      getDailyLimitSeconds(rule) !== null
    );

    return findBestMatchingRule(tab.url, eligible);
  }

  async function sampleOnce(reason = 'event', now = new Date()) {
    let activeRule = null;
    try {
      activeRule = await resolveActiveDailyLimitRule();
    } catch (error) {
      logger?.info?.(`Daily limit sampling could not resolve active tab (${reason}):`, error);
    }

    const result = await dailyLimitManager.recordSample(activeRule?.id ?? null, now);

    if (result.accountedRuleId != null && result.addedSeconds > 0) {
      const rules = await getRules();
      const accountedRule = rules.find(rule => Number(rule.id) === Number(result.accountedRuleId));
      const limitSeconds = accountedRule ? getDailyLimitSeconds(accountedRule) : null;
      const crossedLimit = limitSeconds !== null &&
        result.previousUsageSeconds < limitSeconds &&
        result.currentUsageSeconds >= limitSeconds;

      if (crossedLimit) {
        logger?.log?.(`Daily limit reached for rule ${accountedRule.id}`);
        await dnrSynchronizer.requestSync();
      }
    }

    return result;
  }

  async function runSampleLoop(reason, now) {
    let result;
    do {
      sampleRequestedAgain = false;
      result = await sampleOnce(reason, now);
      now = new Date();
    } while (sampleRequestedAgain);
    return result;
  }

  function sample(reason = 'event', now = new Date()) {
    if (samplePromise) {
      sampleRequestedAgain = true;
      return samplePromise;
    }
    samplePromise = runSampleLoop(reason, now).finally(() => {
      samplePromise = null;
      if (sampleRequestedAgain) return sample(reason);
    });
    return samplePromise;
  }

  return {
    sample,
    resolveActiveDailyLimitRule
  };
}
