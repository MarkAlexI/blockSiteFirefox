import Logger from './logger.js';

const logger = new Logger('FocusSession');

const DEFAULT_FOCUS_SESSION = {
  focusActive: false,
  focusEndTime: 0,
  isHardcore: false,
  focusMode: 'blacklist'
};

export async function getFocusSessionState({ throwOnError = false } = {}) {
  try {
    const result = await browser.storage.local.get(['focusSession']);
    const stored = result.focusSession;
    if (stored?.focusActive !== true) return { ...DEFAULT_FOCUS_SESSION };

    const focusEndTime = Number(stored.focusEndTime);
    if (!Number.isFinite(focusEndTime) || focusEndTime <= 0 || Date.now() >= focusEndTime) {
      logger.log('Found expired or invalid session, treating as inactive.');
      return { ...DEFAULT_FOCUS_SESSION };
    }

    return {
      focusActive: true,
      focusEndTime,
      isHardcore: stored.isHardcore === true,
      focusMode: stored.focusMode === 'whitelist' ? 'whitelist' : 'blacklist'
    };
  } catch (error) {
    if (throwOnError) throw error;
    logger.error('Error getting state:', error);
    return { ...DEFAULT_FOCUS_SESSION };
  }
}

// Per-operation metadata only: retain original exception identities, including
// when a later rearm failure must not hide the original activation failure.
const FOCUS_RECOVERY_PHASES = new Set([
  'state_read', 'state_write', 'alarm_read', 'alarm_create', 'alarm_clear',
  'access_read', 'session_read', 'activation'
]);

export function createFocusRecoveryTrace() {
  const failures = [];
  return {
    async step(phase, operation) {
      if (!FOCUS_RECOVERY_PHASES.has(phase) || typeof operation !== 'function') {
        throw new TypeError('Unsupported Focus recovery step');
      }
      try { return await operation(); }
      catch (error) {
        failures.push({ error, phase });
        throw error;
      }
    },
    getPhase(error) {
      return failures.find(failure => Object.is(failure.error, error))?.phase || 'unknown';
    }
  };
}
