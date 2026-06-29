import Logger from './logger.js';

const logger = new Logger('FocusSession');

export async function getFocusSessionState() {
  try {
    const result = await browser.storage.local.get(['focusSession']);
    const focusSession = result.focusSession || { focusActive: false, focusEndTime: 0, isHardcore: false };

    if (focusSession.focusActive && Date.now() > focusSession.focusEndTime) {
      logger.log('Found expired session, treating as inactive.');
      return { focusActive: false, focusEndTime: 0, isHardcore: false };
    }
    return focusSession;
  } catch (error) {
    logger.error('Error getting state:', error);
    return { focusActive: false, focusEndTime: 0, isHardcore: false };
  }
}