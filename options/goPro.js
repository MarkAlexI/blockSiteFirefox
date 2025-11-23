import { t } from '../scripts/t.js';
import { ProManager } from '../pro/proManager.js';

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
      console.warn("Message sending failed:", e);
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
      console.log("Background worker notified.");
      
      try {
        const settingsResult = await browser.storage.sync.get(['settings']);
        if (settingsResult.settings && settingsResult.settings.enablePassword) {
          console.log("Password protection was on. Resetting due to re-activation...");
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
        }
      } catch (err) {
        console.error("Failed to reset password during re-activation:", err);
      }
      
      licenseMessage.textContent = t('proactivated') || 'Pro activated!';
      licenseMessage.className = 'status-message success show';
      await updateUI();
      
    } catch (error) {
      console.error('Activation Error:', error);
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
      
      licenseMessage.textContent = t('loggedoutsuccess');
      licenseMessage.className = 'status-message success show';
    } catch (error) {
      console.error('Log out error:', error);
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
    console.log('Pro status changed message received, updating UI.');
    updateUI();
  }
});

updateUI();