import Logger from '../utils/logger.js';

const logger = new Logger('Redirect');

async function redirect() {
  try {
    const response = await browser.runtime.sendMessage({ type: 'record_redirect' });
    const destination = response?.success === true && typeof response.to === 'string'
      ? new URL(response.to) : null;
    if (destination && (destination.protocol === 'http:' || destination.protocol === 'https:')) {
      location.replace(destination.href);
      return;
    }
  } catch {
    logger.info('Redirect authorization was not available.');
  }
  location.replace(browser.runtime.getURL('blocked.html'));
}

redirect();
