import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';
import {
  getAssignmentUsageKey,
  getRuleAssignments,
  normalizeRuleAssignments
} from './ruleAssignments.js';
import { BLOCKING_MODE_DAILY_LIMIT } from './blockingMode.js';
import { DAILY_RULE_USAGE_KEY, DAILY_LIMIT_STATE_VERSION } from './dailyLimitManager.js';

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Migrates the stored rule schema without performing any storage operations.
 *
 * Canonical 5.0 assignment schema:
 * - URL / redirect / category belong to the shared rule target.
 * - enabled state and blocking behavior belong to rule.assignments[].
 * - legacy listId/listIds and root disabledByUser/blockingMode/schedule/dailyLimit are removed.
 */
export function migrateRuleSchema(rules) {
  const sourceRules = Array.isArray(rules) ? rules : [];
  let needsSave = false;

  const hasInvalidId = sourceRules.some(rule =>
    !rule.id || typeof rule.id !== 'number' || rule.id > 2000000000
  );
  const hasDuplicates = !hasInvalidId &&
    new Set(sourceRules.map(rule => rule.id)).size !== sourceRules.length;
  const shouldResetAllIds = hasInvalidId || hasDuplicates;

  const migratedRules = sourceRules.map((rule, index) => {
    const migratedRule = { ...rule };

    if (shouldResetAllIds) {
      migratedRule.id = index + 1;
      needsSave = true;
    }

    if (!rule.category) {
      migratedRule.category = rule.isWhitelist ? 'whitelist' : 'uncategorized';
      needsSave = true;
    }

    if (rule.isWhitelist === undefined) {
      migratedRule.isWhitelist = false;
      needsSave = true;
    }

    const assignments = normalizeRuleAssignments(migratedRule);

    if (!sameJson(migratedRule.assignments, assignments)) {
      migratedRule.assignments = assignments;
      needsSave = true;
    }

    for (const legacyKey of ['listId', 'listIds', 'disabledByUser', 'blockingMode', 'schedule', 'dailyLimit']) {
      if (Object.prototype.hasOwnProperty.call(migratedRule, legacyKey)) {
        delete migratedRule[legacyKey];
        needsSave = true;
      }
    }

    return migratedRule;
  });

  return {
    migrated: needsSave,
    idsReset: shouldResetAllIds,
    rules: migratedRules
  };
}

function normalizeUsageSeconds(value) {
  const seconds = Math.floor(Number(value));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Converts the v1 rule-level daily usage map into assignment-scoped keys.
 * Existing elapsed time is cloned to each migrated daily-limit assignment so
 * the update never grants extra budget merely because a rule belonged to more
 * than one list before the assignment migration.
 */
export function migrateDailyUsageSchema(rawState, rules) {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return { migrated: false, state: rawState };
  }

  const usageSeconds = rawState.usageSeconds && typeof rawState.usageSeconds === 'object' && !Array.isArray(rawState.usageSeconds)
    ? rawState.usageSeconds
    : {};
  const nextUsage = {};
  let changed = Number(rawState.version) !== DAILY_LIMIT_STATE_VERSION;

  const rulesById = new Map((rules || []).map(rule => [String(rule.id), rule]));
  const validDailyAssignmentKeys = new Set(
    (rules || []).flatMap(rule => getRuleAssignments(rule)
      .filter(item => item.blockingMode === BLOCKING_MODE_DAILY_LIMIT)
      .map(item => getAssignmentUsageKey(rule.id, item.listId))
      .filter(Boolean))
  );

  // Preserve already assignment-scoped entries when they still point to a
  // real Daily Limit assignment. Numeric v1 keys are expanded below.
  for (const [key, value] of Object.entries(usageSeconds)) {
    const seconds = normalizeUsageSeconds(value);
    if (!seconds) continue;

    if (key.includes(':')) {
      const [ruleId, ...listParts] = key.split(':');
      const listId = listParts.join(':');
      if (validDailyAssignmentKeys.has(key)) {
        nextUsage[key] = seconds;
      } else {
        changed = true;
      }
      continue;
    }

    const rule = rulesById.get(key);
    if (!rule) {
      changed = true;
      continue;
    }

    const dailyAssignments = getRuleAssignments(rule)
      .filter(item => item.blockingMode === BLOCKING_MODE_DAILY_LIMIT);
    for (const assignment of dailyAssignments) {
      const assignmentKey = getAssignmentUsageKey(rule.id, assignment.listId);
      if (assignmentKey) nextUsage[assignmentKey] = Math.max(nextUsage[assignmentKey] || 0, seconds);
    }
    changed = true;
  }

  let nextLastSample = rawState.lastSample ?? null;
  if (nextLastSample && typeof nextLastSample === 'object' && !Array.isArray(nextLastSample)) {
    if (Array.isArray(nextLastSample.assignmentKeys)) {
      const validKeys = nextLastSample.assignmentKeys.filter(key => validDailyAssignmentKeys.has(key));
      if (!sameJson(validKeys, nextLastSample.assignmentKeys)) changed = true;
      nextLastSample = {
        timestamp: Number(nextLastSample.timestamp),
        assignmentKeys: validKeys
      };
    } else if (nextLastSample.ruleId != null) {
      const rule = rulesById.get(String(nextLastSample.ruleId));
      const assignmentKeys = rule
        ? getRuleAssignments(rule)
            .filter(item => item.blockingMode === BLOCKING_MODE_DAILY_LIMIT)
            .map(item => getAssignmentUsageKey(rule.id, item.listId))
            .filter(Boolean)
        : [];
      nextLastSample = {
        timestamp: Number(nextLastSample.timestamp),
        assignmentKeys
      };
      changed = true;
    }
  }

  const state = {
    ...rawState,
    version: DAILY_LIMIT_STATE_VERSION,
    usageSeconds: nextUsage,
    lastSample: nextLastSample
  };

  if (!sameJson(state, rawState)) changed = true;
  return { migrated: changed, state };
}

/**
 * Owns all migration-specific storage behavior. RulesManager remains focused
 * on current rule storage and domain validation.
 */
export function createRulesMigrationService({
  rulesManager,
  ruleListsManager,
  localStorage,
  syncStorage,
  logger
}) {
  async function migrateToLocalForDevice() {
    logger.log(
      'Attempting device-specific rules migration from sync to local storage...'
    );

    try {
      const localData = await localStorage.get([
        'rules',
        'is_migrated_to_local'
      ]);

      if (localData.is_migrated_to_local) {
        logger.log(
          'Rules already migrated to local storage on this device.'
        );
        return false;
      }

      const localRules = Array.isArray(localData.rules) ?
        localData.rules : [];

      if (localRules.length > 0) {
        await localStorage.set({
          is_migrated_to_local: true
        });

        logger.log(
          'Local rules already exist. Preserving them and marking migration complete.'
        );

        return false;
      }

      const syncData = await syncStorage.get('rules');
      const syncRules = Array.isArray(syncData.rules) ?
        syncData.rules : [];

      if (syncRules.length > 0) {
        await localStorage.set({
          rules: syncRules,
          is_migrated_to_local: true
        });

        logger.log(
          `Successfully migrated ${syncRules.length} rules to local storage.`
        );

        return true;
      }

      await localStorage.set({
        is_migrated_to_local: true
      });

      logger.log('No sync rules found to migrate.');
      return false;
    } catch (error) {
      logger.error(
        'Error during device-specific rules migration:',
        error
      );
      return false;
    }
  }

  async function migrateStoredRules() {
    const currentRules = await rulesManager.getRules();
    const result = migrateRuleSchema(currentRules);

    if (result.migrated) {
      await rulesManager.saveRules(result.rules);
    }

    return result;
  }

  async function migrateDailyUsage(rules) {
    try {
      const stored = await localStorage.get(DAILY_RULE_USAGE_KEY);
      const result = migrateDailyUsageSchema(stored[DAILY_RULE_USAGE_KEY], rules);
      if (result.migrated) {
        await localStorage.set({ [DAILY_RULE_USAGE_KEY]: result.state });
      }
      return result;
    } catch (error) {
      logger.error('Error migrating Daily Limit assignment usage:', error);
      return { migrated: false, state: null, error };
    }
  }

  async function migrateAll() {
    const migratedFromSync = await migrateToLocalForDevice();
    let legacyDisabledCategories = [];
    try {
      const syncData = await syncStorage.get('settings');
      legacyDisabledCategories = Array.isArray(syncData?.settings?.disabledCategories)
        ? syncData.settings.disabledCategories
        : [];
    } catch (error) {
      logger.info('Could not read legacy category settings during Rule List migration:', error);
    }

    const [schemaMigration, listMigration] = await Promise.all([
      migrateStoredRules(),
      ruleListsManager?.ensureInitialized?.({ legacyDisabledCategories }) ||
        Promise.resolve({ migrated: false, lists: [], activeRuleListId: GENERAL_RULE_LIST_ID })
    ]);
    const dailyUsageMigration = await migrateDailyUsage(schemaMigration.rules);

    return {
      migrated: migratedFromSync || schemaMigration.migrated || listMigration.migrated || dailyUsageMigration.migrated,
      migratedFromSync,
      schemaMigration,
      listMigration,
      dailyUsageMigration,
      rules: schemaMigration.rules,
      ruleLists: listMigration.lists,
      activeRuleListId: listMigration.activeRuleListId || GENERAL_RULE_LIST_ID
    };
  }

  return {
    migrateToLocalForDevice,
    migrateStoredRules,
    migrateDailyUsage,
    migrateAll
  };
}
