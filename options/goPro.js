import { t } from '../scripts/t.js';
import { ProManager } from '../pro/proManager.js';
import { SettingsManager } from './settings.js';
import { PasswordUtils } from '../pro/password.js';
import Logger from '../utils/logger.js';

const btn = document.getElementById('proBtn');
const wrapper = document.getElementById('proWrapper');
const content = document.getElementById('proContent');
const proBtnText = document.getElementById('proBtnText');

const activateView = document.getElementById('pro-activate-view');
const activeView = document.getElementById('pro-active-view');

const licenseForm = document.getElementById('license-form');
const licenseInput = document.getElementById('license-key-input');
const licenseSubmitBtn = document.getElementById('license-submit-btn');
const licenseMessage = document.getElementById('license-message');

const forceSyncBtn = document.getElementById('force-sync-btn');
const logOutBtn = document.getElementById('log-out-btn');

const VERIFY_API_URL = 'https://blockdistraction.com/api/verifyKey';

function sendMessageToWorker(message) {
  return new Promise((resolve) => {
    try {
      browser.runtime.sendMessage(message, (response) => {
        void browser.runtime.lastError;
        resolve(response);
      });
    } catch (e) {
      Logger.warn("Message sending failed:", e);
      resolve(null);
    }
  });
}

if (wrapper) {
  wrapper.style.maxHeight = '0px';
}
if (btn) {
  const chevron = btn.querySelector('.chevron');
  
  btn.addEventListener('click', () => {
    const isOpen = wrapper.classList.contains('open');
    if (!isOpen) {
      wrapper.classList.add('open');
      wrapper.style.maxHeight = content.scrollHeight + 'px';
      chevron.classList.add('up');
      
      wrapper.addEventListener('transitionend', function handler() {
        wrapper.style.maxHeight = 'none';
        wrapper.removeEventListener('transitionend', handler);
      });
    } else {
      wrapper.style.maxHeight = wrapper.scrollHeight + 'px';
      requestAnimationFrame(() => {
        wrapper.style.maxHeight = '0px';
      });
      wrapper.classList.remove('open');
      chevron.classList.remove('up');
    }
  });
}

async function updateUI() {
  const isPro = await ProManager.isPro();
  
  if (isPro) {
    activateView.style.display = 'none';
    activeView.classList.remove('hidden');
    activeView.style.display = 'block';
    proBtnText.textContent = 'Pro';
  } else {
    activateView.style.display = 'block';
    activeView.style.display = 'none';
    activeView.classList.add('hidden');
    proBtnText.textContent = t('getpro') || 'Get Pro';
  }
  
  if (wrapper && wrapper.classList.contains('open')) {
    wrapper.style.maxHeight = 'none';
    wrapper.style.maxHeight = content.scrollHeight + 'px';
  }
}

if (licenseForm) {
  licenseForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = licenseInput.value.trim();
    
    if (!key) {
      licenseMessage.textContent = t('pleaseenterkey') || 'Please enter a key.';
      licenseMessage.className = 'error-message show';
      return;
    }
    
    licenseMessage.textContent = t('checking') || 'Checking...';
    licenseMessage.className = 'status-message success show';
    licenseSubmitBtn.disabled = true;
    
    try {
      const response = await fetch(VERIFY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key })
      });
      
      const data = await response.json();
      
      if (!response.ok || !data.isPro) {
        throw new Error(data.error || 'Invalid key');
      }
      
      const subscriptionData = {
        licenseKey: key,
        subscriptionEmail: data.email,
        expiryDate: data.expiryDate
      };
      
      await ProManager.updateProStatus(true, subscriptionData);
      
      await sendMessageToWorker({
        type: 'update_pro_status',
        isPro: true,
        subscriptionData: subscriptionData
      });
      Logger.log("Background worker notified.");
      
      try {
        const settingsResult = await browser.storage.sync.get(['settings']);
        if (settingsResult.settings && settingsResult.settings.enablePassword) {
          Logger.log("Password protection was on. Resetting due to re-activation...");
          const newSettings = {
            ...settingsResult.settings,
            enablePassword: false,
            passwordHash: null
          };
          await browser.storage.sync.set({ settings: newSettings });
          
          const enablePasswordToggle = document.getElementById('enablePassword');
          if (enablePasswordToggle) {
            enablePasswordToggle.checked = false;
          }
          
          licenseInput.value = '';
        }
      } catch (err) {
        Logger.error("Failed to reset password during re-activation:", err);
      }
      
      licenseMessage.textContent = t('proactivated') || 'Pro activated!';
      licenseMessage.className = 'status-message success show';
      await updateUI();
      
    } catch (error) {
      Logger.error('Activation Error:', error);
      licenseMessage.textContent = t('subscriptionnotfound') || 'Subscription not found or key is invalid.';
      licenseMessage.className = 'error-message show';
    } finally {
      licenseSubmitBtn.disabled = false;
      
      setTimeout(() => {
        licenseMessage.className = 'hidden';
      }, 3000);
    }
  });
}

if (forceSyncBtn) {
  forceSyncBtn.addEventListener('click', async () => {
    forceSyncBtn.disabled = true;
    forceSyncBtn.textContent = 'Syncing...';
    
    licenseMessage.textContent = t('syncing');
    licenseMessage.className = 'status-message success show';
    
    const response = await sendMessageToWorker({ type: 'force_sync' });
    
    forceSyncBtn.disabled = false;
    forceSyncBtn.textContent = t('forcesync') || 'Force Sync / Check Status';
    
    if (response && response.success) {
      licenseMessage.textContent = t('syncsuccess') + (response.isPro ? ' (Pro Active)' : ' (Free)');
      licenseMessage.className = 'status-message success show';
      updateUI();
    } else {
      const errorMsg = (response && response.error) ? response.error : 'No response';
      licenseMessage.textContent = t('syncfailed') + `: ${errorMsg}`;
      licenseMessage.className = 'error-message show';
    }
    
    setTimeout(() => {
      licenseMessage.className = 'hidden';
    }, 3000);
  });
}

if (logOutBtn) {
  logOutBtn.addEventListener('click', async () => {
    try {
      const settings = await SettingsManager.getSettings();
      
      if (settings.enablePassword) {
        const isAuthorized = await new Promise((resolve) => {
          PasswordUtils.showPasswordModal('verify', (isValid) => {
            resolve(isValid);
          }, t);
        });
        
        if (!isAuthorized) {
          return;
        }
      }
    } catch (error) {
      Logger.error("Error checking settings before logout:", error);
    }
    
    try {
      const emptyData = {
        licenseKey: null,
        subscriptionEmail: null,
        expiryDate: null
      };
      
      await ProManager.updateProStatus(false, emptyData);
      
      await sendMessageToWorker({
        type: 'update_pro_status',
        isPro: false,
        subscriptionData: emptyData
      });
      
      await updateUI();
      
      const settings = await SettingsManager.getSettings();
      if (settings.enablePassword) {
        await SettingsManager.saveSettings({
          ...settings,
          enablePassword: false
        });
        window.location.reload();
        return;
      }
      
      licenseInput.value = '';
      licenseMessage.textContent = t('loggedoutsuccess');
      licenseMessage.className = 'status-message success show';
    } catch (error) {
      Logger.error('Log out error:', error);
      licenseMessage.textContent = t('loggedouterror');
      licenseMessage.className = 'error-message show';
    } finally {
      setTimeout(() => {
        licenseMessage.className = 'hidden';
      }, 3000);
    }
  });
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'pro_status_changed') {
    Logger.log('Pro status changed message received, updating UI.');
    updateUI();
  }
});

updateUI();

const proSection = document.getElementById('pro-section');

document.addEventListener('DOMContentLoaded', () => {
  browser.storage.local.get(['is_reviewer_mode'], (result) => {
    if (result.is_reviewer_mode) {
      proSection.classList.remove('hidden');
      Logger.log('Dev/Reviewer mode is active (loaded from storage)');
    }
  });
});

window.unlockPro = () => {
  proSection.classList.remove('hidden');
  
  browser.storage.local.set({ is_reviewer_mode: true }, () => {
    Logger.log('✅ Pro Section Unlocked & Saved!');
    Logger.log('To lock it back, run: window.lockPro()');
  });
};

window.lockPro = () => {
  proSection.classList.add('hidden');
  browser.storage.local.remove('is_reviewer_mode', () => {
    Logger.log('🔒 Pro Section Locked (Storage cleared)');
  });
};

const logo = document.getElementById('header-text');
let pressTimer;

const cancelTimer = () => {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
};

logo.addEventListener('pointerdown', (e) => {
  if (e.button === 0) {
    pressTimer = setTimeout(() => {
      window.unlockPro();
      if (navigator.vibrate) navigator.vibrate(200);
    }, 7000);
  }
});

logo.addEventListener('pointerup', cancelTimer);

logo.addEventListener('pointerleave', cancelTimer);