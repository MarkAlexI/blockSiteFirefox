/**
 * Migrates the stored rule schema without performing any storage operations.
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

    if (rule.disabledByUser === undefined) {
      migratedRule.disabledByUser = false;
      needsSave = true;
    }

    if (rule.isWhitelist === undefined) {
      migratedRule.isWhitelist = false;
      needsSave = true;
    }

    return migratedRule;
  });

  return {
    migrated: needsSave,
    idsReset: shouldResetAllIds,
    rules: migratedRules
  };
}

/**
 * Owns all migration-specific storage behavior. RulesManager remains focused
 * on current rule storage and domain validation.
 */
export function createRulesMigrationService({
  rulesManager,
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

  async function migrateAll() {
    const migratedFromSync = await migrateToLocalForDevice();
    const schemaMigration = await migrateStoredRules();

    return {
      migrated: migratedFromSync || schemaMigration.migrated,
      migratedFromSync,
      schemaMigration,
      rules: schemaMigration.rules
    };
  }

  return {
    migrateToLocalForDevice,
    migrateStoredRules,
    migrateAll
  };
}
