import Logger from '../utils/logger.js';

const logger = new Logger('Redirect');

try {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('from');
  const toUrl = url.searchParams.get('to');
  
  if (fromUrl && toUrl) {
    try {
      browser.runtime.sendMessage({
        type: 'record_redirect',
        from: fromUrl,
        to: toUrl
      });
    } catch (error) {
      logger.error('Error sending redirect record message:', error);
    }
    
    location.replace(toUrl);
    
  } else {
    logger.warn('Redirect page called without "from" or "to" params.');
    location.replace(browser.runtime.getURL("blocked.html"));
  }
} catch (error) {
  logger.error('Error in redirect script:', error);
  location.replace(browser.runtime.getURL("blocked.html"));
}