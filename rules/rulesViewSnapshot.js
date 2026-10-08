import { normalizeRuleLists, normalizeActiveRuleListId, ACTIVE_RULE_LIST_KEY } from './ruleListsManager.js';
import { DAILY_RULE_USAGE_KEY, PENDING_DAILY_USAGE_REMAPS_KEY, projectDailyUsageSeconds } from './dailyLimitManager.js';

// One storage read prevents rules, profiles and budgets from different commits
// being joined by a UI reader. Pending remaps are projected, never persisted.
export async function readRulesViewSnapshot(storageArea = chrome.storage.local, now = null) {
  const raw = await storageArea.get([
    'rules', 'rulesGeneration', 'ruleRevisions', 'ruleLists', ACTIVE_RULE_LIST_KEY,
    'ruleListRevisions', DAILY_RULE_USAGE_KEY, PENDING_DAILY_USAGE_REMAPS_KEY
  ]);
  const lists = normalizeRuleLists(raw.ruleLists);
  const generation = raw.rulesGeneration ?? null;
  return {
    snapshot: { rules: raw.rules || [], generation, revisions: raw.ruleRevisions || {} },
    ruleListState: { lists, activeRuleListId: normalizeActiveRuleListId(lists, raw[ACTIVE_RULE_LIST_KEY]),
      generation, revisions: raw.ruleListRevisions || {} },
    dailyUsageSeconds: projectDailyUsageSeconds(raw[DAILY_RULE_USAGE_KEY], raw[PENDING_DAILY_USAGE_REMAPS_KEY], now || new Date())
  };
}
