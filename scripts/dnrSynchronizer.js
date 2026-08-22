import { getRuleAssignment } from '../rules/ruleAssignments.js';
import { GENERAL_RULE_LIST_ID } from '../rules/ruleListsManager.js';

const SAFE_DYNAMIC_RULE_ACTIONS = new Set([
  'block',
  'allow',
  'allowAllRequests',
  'upgradeScheme'
]);

function getPositiveRuleLimit(value) {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

export function getDnrRuleCapacity(declarativeNetRequest = {}) {
  return {
    maxDynamicRules:
      getPositiveRuleLimit(declarativeNetRequest?.MAX_NUMBER_OF_DYNAMIC_RULES) ??
      getPositiveRuleLimit(declarativeNetRequest?.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES),
    maxUnsafeDynamicRules:
      getPositiveRuleLimit(declarativeNetRequest?.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES)
  };
}

function inspectDnrRuleCapacity(expectedRules, declarativeNetRequest) {
  const limits = getDnrRuleCapacity(declarativeNetRequest);
  const expectedUnsafeCount = expectedRules.filter(rule =>
    !SAFE_DYNAMIC_RULE_ACTIONS.has(rule?.action?.type)
  ).length;
  const unsafeLimitExceeded = limits.maxUnsafeDynamicRules !== null &&
    expectedUnsafeCount > limits.maxUnsafeDynamicRules;
  const dynamicLimitExceeded = limits.maxDynamicRules !== null &&
    expectedRules.length > limits.maxDynamicRules;

  return {
    ...limits,
    expectedCount: expectedRules.length,
    expectedUnsafeCount,
    withinCapacity: !unsafeLimitExceeded && !dynamicLimitExceeded,
    limitType: unsafeLimitExceeded ? 'unsafe_dynamic' :
      dynamicLimitExceeded ? 'dynamic' : null
  };
}

function createDnrCapacityError(capacity) {
  const unsafeLimit = capacity.limitType === 'unsafe_dynamic';
  const expected = unsafeLimit ? capacity.expectedUnsafeCount : capacity.expectedCount;
  const maximum = unsafeLimit ? capacity.maxUnsafeDynamicRules : capacity.maxDynamicRules;
  const label = unsafeLimit ? 'unsafe dynamic' : 'dynamic';
  const error = new Error(
    `Browser ${label} rule limit reached (${expected}/${maximum})`
  );
  error.name = 'DnrCapacityError';
  error.code = 'dnr_rule_limit_reached';
  error.capacity = capacity;
  return error;
}

function getDnrErrorCode(error) {
  if (error?.code === 'dnr_rule_limit_reached') return error.code;
  const message = String(error?.message || '');
  return /MAX_NUMBER_OF_(?:UNSAFE_)?DYNAMIC(?:_AND_SESSION)?_RULES|(?:(?:dynamic|unsafe).{0,40}(?:quota|limit|exceed)|(?:quota|limit|exceed).{0,40}(?:dynamic|unsafe))/i.test(message)
    ? 'dnr_rule_limit_reached'
    : null;
}

/**
 * Builds a stable signature from the DNR fields that define rule behavior.
 * This does not normalize or reinterpret user-entered block patterns.
 */
export function getDnrSignature(rule) {
  return JSON.stringify({
    id: Math.floor(Number(rule.id)),
    priority: rule.priority ?? 1,
    action: {
      type: rule.action?.type ?? null,
      redirectUrl: rule.action?.redirect?.url ?? null
    },
    condition: {
      urlFilter: rule.condition?.urlFilter ?? null,
      resourceTypes: [...(rule.condition?.resourceTypes ?? [])].sort()
    }
  });
}

/**
 * Returns the atomic DNR update required to transform current rules into
 * expected rules. Changed rules keep their ID and appear in both collections.
 */
export function buildDnrDiff(currentRules, expectedRules) {
  const currentById = new Map(
    currentRules.map(rule => [rule.id, rule])
  );
  const expectedById = new Map(
    expectedRules.map(rule => [rule.id, rule])
  );

  const removeRuleIds = [];
  const addRules = [];

  for (const currentRule of currentRules) {
    const expectedRule = expectedById.get(currentRule.id);

    if (
      !expectedRule ||
      getDnrSignature(currentRule) !== getDnrSignature(expectedRule)
    ) {
      removeRuleIds.push(currentRule.id);
    }
  }

  for (const expectedRule of expectedRules) {
    const currentRule = currentById.get(expectedRule.id);

    if (
      !currentRule ||
      getDnrSignature(currentRule) !== getDnrSignature(expectedRule)
    ) {
      addRules.push(expectedRule);
    }
  }

  return { removeRuleIds, addRules };
}

/**
 * Creates a DNR synchronizer with explicit dependencies so the behavior can be
 * tested without loading the complete extension service worker.
 */
export function createDnrSynchronizer({
  getRules,
  getRuleListState = async () => ({ lists: [], activeRuleListId: 'general' }),
  getDailyUsage = async () => ({}),
  getFocusSessionState,
  getAccess = async () => ({ isPro: true, isLegacyUser: false }),
  isRuleActiveNow,
  createDnrRule,
  closeTabsMatchingRules,
  declarativeNetRequest,
  logger,
  onSyncResult = async () => {}
}) {
  let rulesSyncPromise = null;
  let syncRequestedAgain = false;
  let syncGeneration = 0;
  let pendingTabReconciliation = false;
  let activeTabReconciliation = false;

  async function buildExpectedDnrState(candidate = {}) {
    const rules = Array.isArray(candidate.rules) ? candidate.rules : await getRules();
    const [ruleListState, dailyUsage, focusState] = await Promise.all([
      candidate.ruleListState || getRuleListState(),
      getDailyUsage(),
      candidate.focusState || getFocusSessionState()
    ]);
    const { focusActive } = focusState;
    const access = focusActive ? (candidate.access || await getAccess()) : null;
    const limitFocusToGeneral = focusActive && !access?.isPro && !access?.isLegacyUser;
    const activeRuleListId = limitFocusToGeneral
      ? GENERAL_RULE_LIST_ID
      : ruleListState?.activeRuleListId || GENERAL_RULE_LIST_ID;
    const activeProfile = (ruleListState?.lists || []).find(list => list?.id === activeRuleListId);
    const disabledCategories = activeProfile?.disabledCategories || [];
    const now = new Date();

    let activeRules = rules.filter(rule =>
      !rule.isWhitelist &&
      (!limitFocusToGeneral || Boolean(getRuleAssignment(rule, GENERAL_RULE_LIST_ID))) &&
      isRuleActiveNow(rule, disabledCategories, focusActive, now, activeRuleListId, dailyUsage)
    );

    if (focusActive) {
      const byBlockURL = new Map();
      for (const rule of activeRules) {
        const key = String(rule.blockURL || '').trim().toLowerCase();
        if (!key) continue;
        const current = byBlockURL.get(key);
        if (!current) {
          byBlockURL.set(key, rule);
          continue;
        }
        const currentBelongsToActiveProfile = Boolean(getRuleAssignment(current, activeRuleListId));
        const candidateBelongsToActiveProfile = Boolean(getRuleAssignment(rule, activeRuleListId));
        if (candidateBelongsToActiveProfile && !currentBelongsToActiveProfile) {
          byBlockURL.set(key, rule);
        }
      }
      activeRules = [...byBlockURL.values()];
    }

    const dnrRules = [];

    for (const rule of activeRules) {
      const dnrRule = await createDnrRule(
        rule.id,
        rule.blockURL,
        rule.redirectURL
      );

      if (dnrRule) {
        dnrRules.push(dnrRule);
      }
    }

    return { activeRules, dnrRules };
  }

  async function syncActiveRulesOnce(generation, reconcileExistingTabs) {
    const { activeRules, dnrRules: expectedRules } =
      await buildExpectedDnrState();
    const currentRules = await declarativeNetRequest.getDynamicRules();
    const { removeRuleIds, addRules } =
      buildDnrDiff(currentRules, expectedRules);
    const changed = removeRuleIds.length > 0 || addRules.length > 0;

    if (changed) {
      if (addRules.length > 0) {
        const capacity = inspectDnrRuleCapacity(expectedRules, declarativeNetRequest);
        if (!capacity.withinCapacity) throw createDnrCapacityError(capacity);
      }

      // Always pass both arrays. In particular, clearing all rules requires the
      // complete removeRuleIds array together with addRules: [].
      await declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules
      });

      logger.log(
        `DNR diff applied: removed ${removeRuleIds.length}, added ${addRules.length}`
      );
    }

    const shouldReconcileTabs = changed || reconcileExistingTabs;

    if (shouldReconcileTabs && activeRules.length > 0 && generation === syncGeneration) {
      await closeTabsMatchingRules(
        activeRules.map(rule => rule.blockURL),
        () => generation === syncGeneration
      );
    }

    // A newer passive watchdog may supersede this generation after a real DNR
    // change. Carry its necessary tab cleanup into the fresh rules snapshot.
    if (shouldReconcileTabs && generation !== syncGeneration) {
      pendingTabReconciliation = true;
    }

    return {
      success: true,
      changed,
      removed: removeRuleIds.length,
      added: addRules.length
    };
  }

  async function runRulesSyncLoop() {
    let lastResult = {
      success: true,
      changed: false,
      removed: 0,
      added: 0
    };

    do {
      syncRequestedAgain = false;
      const generation = syncGeneration;
      activeTabReconciliation = pendingTabReconciliation;
      pendingTabReconciliation = false;

      try {
        lastResult = await syncActiveRulesOnce(generation, activeTabReconciliation);
      } catch (error) {
        logger.info('Error updating active rules:', error);
        const code = getDnrErrorCode(error);
        lastResult = {
          success: false,
          changed: false,
          removed: 0,
          added: 0,
          error: error?.message || String(error),
          errorName: error?.name || 'Error',
          ...(code ? { code } : {}),
          ...(error?.capacity ? { capacity: error.capacity } : {})
        };
      } finally {
        activeTabReconciliation = false;
      }
    } while (syncRequestedAgain);

    try {
      await onSyncResult(lastResult);
    } catch (error) {
      logger.warn('Failed to record DNR sync diagnostics:', error);
    }

    return lastResult;
  }

  function requestSync({ reconcileExistingTabs = true } = {}) {
    pendingTabReconciliation ||= reconcileExistingTabs !== false;
    syncGeneration += 1;
    if (rulesSyncPromise) {
      // A passive watchdog must not cancel an explicit startup, mutation, or
      // Focus request that has not finished reconciling existing tabs.
      pendingTabReconciliation ||= activeTabReconciliation;
      syncRequestedAgain = true;
      return rulesSyncPromise;
    }

    rulesSyncPromise = runRulesSyncLoop()
      .finally(() => {
        rulesSyncPromise = null;

        // Covers a request arriving after the loop's final condition check but
        // before the active promise has completed its cleanup.
        if (syncRequestedAgain) {
          return requestSync({ reconcileExistingTabs: pendingTabReconciliation });
        }
      });

    return rulesSyncPromise;
  }

  async function inspectState() {
    const { activeRules, dnrRules: expectedRules } = await buildExpectedDnrState();
    const currentRules = await declarativeNetRequest.getDynamicRules();
    const { removeRuleIds, addRules } =
      buildDnrDiff(currentRules, expectedRules);
    const capacity = inspectDnrRuleCapacity(expectedRules, declarativeNetRequest);

    return {
      activeRuleCount: activeRules.length,
      expectedCount: expectedRules.length,
      expectedUnsafeCount: capacity.expectedUnsafeCount,
      currentCount: currentRules.length,
      inSync: removeRuleIds.length === 0 && addRules.length === 0,
      removeCount: removeRuleIds.length,
      addCount: addRules.length,
      maxDynamicRules: capacity.maxDynamicRules,
      maxUnsafeDynamicRules: capacity.maxUnsafeDynamicRules,
      withinCapacity: capacity.withinCapacity
    };
  }

  async function validateRuleCapacity(rules, ruleListState = null, focusState = null, access = null) {
    const limits = getDnrRuleCapacity(declarativeNetRequest);
    if (limits.maxDynamicRules === null && limits.maxUnsafeDynamicRules === null) {
      return { ...limits, withinCapacity: true };
    }

    const { dnrRules } = await buildExpectedDnrState({
      rules,
      ruleListState,
      focusState,
      access
    });
    return inspectDnrRuleCapacity(dnrRules, declarativeNetRequest);
  }

  async function validateIntegrity() {
    try {
      const state = await inspectState();

      if (!state.inSync) {
        logger.warn('DNR rules out of sync, triggering sync...');
        await requestSync();
      }

      return state.inSync;
    } catch (error) {
      logger.error('DNR integrity check failed:', error);
      return false;
    }
  }

  return {
    requestSync,
    validateIntegrity,
    inspectState,
    validateRuleCapacity
  };
}
