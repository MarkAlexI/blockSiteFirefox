import { t } from '../scripts/t.js';

// A committed mutation can still be waiting for browser rules or usage recovery.
// Keep that outcome successful so callers finish refreshing the saved state.
export function getRulesMutationFeedback(result, successMessage = '') {
  const pending = result?.syncPending === true || result?.dailyUsageSyncPending === true;
  return {
    pending,
    message: pending ? t('ruleschangessavedpending') : successMessage
  };
}
