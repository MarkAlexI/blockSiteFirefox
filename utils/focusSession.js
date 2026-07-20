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
    const focusSession = { ...DEFAULT_FOCUS_SESSION, ...result.focusSession };

    if (focusSession.focusActive && Date.now() > focusSession.focusEndTime) {
      logger.log('Found expired session, treating as inactive.');
      return { ...DEFAULT_FOCUS_SESSION };
    }
    return focusSession;
  } catch (error) {
    logger.error('Error getting state:', error);
    return { ...DEFAULT_FOCUS_SESSION };
  }
}
