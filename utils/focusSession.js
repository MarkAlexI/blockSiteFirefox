import Logger from './logger.js';

const logger = new Logger('FocusSession');

const DEFAULT_FOCUS_SESSION = {
  focusActive: false,
  focusEndTime: 0,
  isHardcore: false,
  focusMode: 'blacklist'
};

export async function getFocusSessionState() {
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
    logger.error('Error getting state:', error);
    return { ...DEFAULT_FOCUS_SESSION };
  }
}
