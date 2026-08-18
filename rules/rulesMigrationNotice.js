export const RULES_MIGRATION_NOTICE_VERSION_KEY = 'rulesMigrationNoticeVersion';

/**
 * Claims the one-time compatibility notice for an extension update.
 * Internal state migrations, browser startup, and normal imports must not
 * surface a user-facing migration alert.
 */
export async function claimRulesMigrationNotice({
  details,
  migrationResult,
  storageArea,
  extensionVersion
}) {
  if (details?.reason !== 'update' || migrationResult?.userVisibleMigration !== true) {
    return false;
  }

  const version = String(extensionVersion || '').trim();
  if (!version || !storageArea?.get || !storageArea?.set) return false;

  const stored = await storageArea.get(RULES_MIGRATION_NOTICE_VERSION_KEY);
  if (stored?.[RULES_MIGRATION_NOTICE_VERSION_KEY] === version) return false;

  // Claim before broadcasting so concurrent/repeated initialization cannot
  // produce duplicate alerts for the same extension version.
  await storageArea.set({ [RULES_MIGRATION_NOTICE_VERSION_KEY]: version });
  return true;
}
