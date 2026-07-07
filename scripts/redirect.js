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
        from: decodeURIComponent(fromUrl),
        to: toUrl
      });
    } catch (error) {
      logger.error('Error sending redirect record message:', error);
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