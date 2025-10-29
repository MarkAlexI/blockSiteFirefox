import { t } from '../scripts/t.js';

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
  
  browser.permissions.contains({ origins: ["*://*/"] }, (hasPermissions) => {
    if (hasPermissions) {
      statusMsg.textContent = t('onboarding_status_success');
      statusMsg.className = 'success';
      statusMsg.style.display = 'block';
      grantBtn.style.display = 'none';
      
      browser.runtime.sendMessage({ type: 'permissions_granted' }, () => {
        setTimeout(() => {
          window.close();
        }, 3000);
      });
    }
  });
  
  grantBtn.addEventListener('click', async () => {
    grantBtn.disabled = true;
    
    try {
      const granted = await browser.permissions.request({
        origins: ["*://*/"]
      });
      
      if (granted) {
        statusMsg.textContent = t('onboarding_status_success');
        statusMsg.className = 'success';
        statusMsg.style.display = 'block';
        grantBtn.style.display = 'none';
        
        browser.runtime.sendMessage({ type: 'permissions_granted' }, () => {
          setTimeout(() => {
            browser.runtime.sendMessage({
              type: 'close_current_tab'
            });
          }, 3000);
        });
      } else {
        statusMsg.textContent = t('onboarding_status_denied');
        statusMsg.className = 'error';
        statusMsg.style.display = 'block';
        grantBtn.disabled = false;
      }
    } catch (err) {
      console.error('Error requesting permission:', err);
      statusMsg.textContent = t('onboarding_status_api_error');
      statusMsg.className = 'error';
      statusMsg.style.display = 'block';
      grantBtn.disabled = false;
    }
  });
});