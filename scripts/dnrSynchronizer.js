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
  getSettings,
  getRuleLists = async () => [],
  getFocusSessionState,
  isRuleActiveNow,
  createDnrRule,
  closeTabsMatchingRules,
  declarativeNetRequest,
  logger,
  onSyncResult = async () => {}
}) {
  let rulesSyncPromise = null;
  let syncRequestedAgain = false;

  async function buildExpectedDnrState() {
    const rules = await getRules();
    const [settings, ruleLists, focusState] = await Promise.all([
      getSettings(),
      getRuleLists(),
      getFocusSessionState()
    ]);
    const { focusActive } = focusState;
    const disabledCategories = settings.disabledCategories || [];
    const disabledRuleListIds = (ruleLists || [])
      .filter(list => list?.disabled === true)
      .map(list => list.id);
    const now = new Date();

    const activeRules = rules.filter(rule =>
      !rule.isWhitelist &&
      isRuleActiveNow(rule, disabledCategories, focusActive, now, disabledRuleListIds)
    );

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

  async function syncActiveRulesOnce() {
    const { activeRules, dnrRules: expectedRules } =
      await buildExpectedDnrState();
    const currentRules = await declarativeNetRequest.getDynamicRules();
    const { removeRuleIds, addRules } =
      buildDnrDiff(currentRules, expectedRules);

    if (removeRuleIds.length > 0 || addRules.length > 0) {
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

    const urlsToClose = activeRules.map(rule => rule.blockURL);

    if (urlsToClose.length > 0) {
      await closeTabsMatchingRules(urlsToClose);
    }

    return {
      success: true,
      changed: removeRuleIds.length > 0 || addRules.length > 0,
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

      try {
        lastResult = await syncActiveRulesOnce();
      } catch (error) {
        logger.info('Error updating active rules:', error);
        lastResult = {
          success: false,
          changed: false,
          removed: 0,
          added: 0,
          error: error?.message || String(error)
        };
      }
    } while (syncRequestedAgain);

    try {
      await onSyncResult(lastResult);
    } catch (error) {
      logger.warn('Failed to record DNR sync diagnostics:', error);
    }

    return lastResult;
  }

  function requestSync() {
    if (rulesSyncPromise) {
      syncRequestedAgain = true;
      return rulesSyncPromise;
    }

    rulesSyncPromise = runRulesSyncLoop()
      .finally(() => {
        rulesSyncPromise = null;

        // Covers a request arriving after the loop's final condition check but
        // before the active promise has completed its cleanup.
        if (syncRequestedAgain) {
          return requestSync();
        }
      });

    return rulesSyncPromise;
  }

  async function inspectState() {
    const { activeRules, dnrRules: expectedRules } = await buildExpectedDnrState();
    const currentRules = await declarativeNetRequest.getDynamicRules();
    const { removeRuleIds, addRules } =
      buildDnrDiff(currentRules, expectedRules);

    return {
      activeRuleCount: activeRules.length,
      expectedCount: expectedRules.length,
      currentCount: currentRules.length,
      inSync: removeRuleIds.length === 0 && addRules.length === 0,
      removeCount: removeRuleIds.length,
      addCount: addRules.length
    };
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
    inspectState
  };
}
