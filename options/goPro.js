import { t } from '../scripts/t.js';
import { ProManager } from '../pro/proManager.js';

const btn = document.getElementById('proBtn');
const wrapper = document.getElementById('proWrapper');
const content = document.getElementById('proContent');

if (wrapper) {
  wrapper.style.maxHeight = '0px';
}

if (btn) {
  const chevron = btn.querySelector('.chevron');
  
  btn.addEventListener('click', () => {
    if (!wrapper.classList.contains('open')) {
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

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const messageEl = document.getElementById('message');
  
  if (!email) {
    messageEl.textContent = t('pleaseenteremail');
    return;
  }
  
  messageEl.textContent = t('checking');
  messageEl.className = '';
  
  try {
    const response = await fetch('https://checksubscription-hwyz3hlg7a-uc.a.run.app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    
    const data = await response.json();
    if (data.isActive) {
      await ProManager.updateProStatus(true, data);
      
      messageEl.textContent = t('proactivated');
      messageEl.className = 'success';
      document.getElementById('email').value = '';
    } else {
      messageEl.textContent = t('subscriptionnotfound');
      messageEl.className = 'error';
    }
  } catch (error) {
    console.error('Error checking subscription:', error);
    messageEl.textContent = t('servererror');
    messageEl.className = 'error';
  }
});

const credentials = await ProManager.getCredentials();

if (credentials.isPro && credentials.subscriptionEmail) {
  const messageEl = document.getElementById('message');
  messageEl.textContent = `${t('proactivatedfor')} ${credentials.subscriptionEmail}`;
  messageEl.className = 'success';
  document.getElementById('login-form').style.display = 'none';
}