import Logger from '../utils/logger.js';

const logger = new Logger('Redirect');

try {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('from');
  const toUrl = url.searchParams.get('to');
  
  if (fromUrl && toUrl) {
    try {
      const request = browser.runtime.sendMessage({
        type: 'record_redirect',
        from: decodeURIComponent(fromUrl),
        to: toUrl
      });
      if (request && typeof request.catch === 'function') {
        request.catch(error => {
          logger.info('Redirect record message was not delivered:', error);
        });
      }
    } catch (error) {
      logger.info('Redirect record message was not delivered:', error);
    }
    
    if (toUrl.startsWith('http://') || toUrl.startsWith('https://')) {
      location.replace(toUrl);
    } else {
      location.replace('https://' + toUrl);
    }
  }
  
} catch (error) {
  logger.error('Error in redirect script:', error);
  location.replace(browser.runtime.getURL("blocked.html"));
}