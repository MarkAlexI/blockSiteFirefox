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

const VERIFY_API_URL = 'https://blockdistraction.com/api/verifyKey';

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
    proBtnText.textContent = 'Pro';
  } else {
    activateView.style.display = 'block';
    activeView.style.display = 'none';
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
      licenseMessage.classList.remove('hidden');
      return;
    }
    
    licenseMessage.textContent = t('checking') || 'Checking...';
    licenseMessage.className = '';
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
      
      await ProManager.updateProStatus(true, {
        licenseKey: key,
        subscriptionEmail: data.email,
        expiryDate: data.expiryDate
      });
      
      licenseMessage.textContent = t('proactivated') || 'Pro activated!';
      licenseMessage.className = 'success';
      await updateUI();
      
    } catch (error) {
      console.error('Activation Error:', error);
      licenseMessage.textContent = t('subscriptionnotfound') || 'Subscription not found or key is invalid.';
      licenseMessage.className = 'error';
    } finally {
      licenseSubmitBtn.disabled = false;
    }
  });
}

if (forceSyncBtn) {
  forceSyncBtn.addEventListener('click', () => {
    forceSyncBtn.textContent = 'Syncing...';
    browser.runtime.sendMessage({ type: 'force_sync' }, (response) => {
      forceSyncBtn.textContent = 'Force Sync / Check Status';
      if (response && response.success) {
        alert('Sync complete. Status: ' + (response.isPro ? 'Pro Active' : 'Free'));
      } else {
        alert('Sync failed. Please check your connection or key.');
      }
    });
  });
}

updateUI();