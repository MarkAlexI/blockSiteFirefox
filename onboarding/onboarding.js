import { t } from '../scripts/t.js';
import Logger from '../utils/logger.js';

const logger = new Logger('Onboarding');

function sendFireAndForget(message) {
  try {
    const request = browser.runtime.sendMessage(message);
    if (request && typeof request.catch === 'function') {
      request.catch(() => {});
    }
  } catch {
    // The onboarding UI can continue even if the background page is unavailable.
  }
}

function notifyPermissionsGrantedAndScheduleClose() {
  sendFireAndForget({ type: 'permissions_granted' });
  setTimeout(() => {
    sendFireAndForget({ type: 'close_current_tab' });
  }, 3000);
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const placeholderKey = el.getAttribute('data-i18n-placeholder');
    
    if (key) {
      el.textContent = t(key);
    }
    if (placeholderKey) {
      el.setAttribute('placeholder', t(placeholderKey));
    }
  });
  
  document.title = t('onboarding_title');
}

applyTranslations();

document.addEventListener('DOMContentLoaded', () => {
  const grantBtn = document.getElementById('grant-permission-btn');
  const statusMsg = document.getElementById('status-message');
  
  if (browser.permissions) {
    browser.permissions.contains({ origins: ["*://*/*"] }, (hasPermissions) => {
      if (hasPermissions) {
        statusMsg.textContent = t('onboarding_status_success');
        statusMsg.className = 'success';
        statusMsg.style.display = 'block';
        grantBtn.style.display = 'none';
        
        notifyPermissionsGrantedAndScheduleClose();
      }
    });
  }
  
  grantBtn.addEventListener('click', async () => {
    grantBtn.disabled = true;
    
    try {
      let granted;
      if (browser.permissions) {
        granted = await browser.permissions.request({
          origins: ["*://*/*"]
        });
      }
      
      if (granted) {
        statusMsg.textContent = t('onboarding_status_success');
        statusMsg.className = 'success';
        statusMsg.style.display = 'block';
        grantBtn.style.display = 'none';
        
        notifyPermissionsGrantedAndScheduleClose();
      } else {
        statusMsg.textContent = t('onboarding_status_denied');
        statusMsg.className = 'error';
        statusMsg.style.display = 'block';
        grantBtn.disabled = false;
      }
    } catch (err) {
      logger.error('Error requesting permission:', err);
      statusMsg.textContent = t('onboarding_status_api_error');
      statusMsg.className = 'error';
      statusMsg.style.display = 'block';
      grantBtn.disabled = false;
    }
  });
});