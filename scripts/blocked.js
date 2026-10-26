import { t } from './t.js';
import './i18n.js';

const closeBtn = document.getElementById('closeBtn');
const blockedReason = document.getElementById('blockedReason');
const closeStatus = document.getElementById('closeStatus');
const reasonMessageKeys = Object.freeze({
  always: 'blocking_mode_always',
  schedule: 'rule_scheduled',
  daily_limit: 'daily_limit_reached',
  focus: 'focussessionheader'
});

try {
  const reason = new URL(window.location.href).searchParams.get('reason');
  const messageKey = Object.hasOwn(reasonMessageKeys, reason) ? reasonMessageKeys[reason] : null;
  if (blockedReason && messageKey) {
    blockedReason.setAttribute('data-i18n', messageKey);
    blockedReason.textContent = t(messageKey);
  }
} catch {
  // Keep the generic localized message for incomplete or malformed URLs.
}

let pending = false, active = true, generation = 0;
window.addEventListener?.('pagehide', () => { active = false; generation += 1; });
window.addEventListener?.('pageshow', event => {
  if (!event.persisted) return;
  active = true;
  pending = false;
  closeBtn.setAttribute('aria-disabled', 'false');
  if (closeStatus) closeStatus.textContent = '';
});
closeBtn.addEventListener('keydown', event => {
  if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
});
closeBtn.addEventListener('click', () => {
  if (pending || !active) return;
  const request = generation;
  pending = true;
  closeBtn.setAttribute('aria-disabled', 'true');
  if (closeStatus) closeStatus.textContent = t('blockedclosepending');
  void closeCurrentTab(request).then(() => {
    if (active && request === generation && closeStatus) closeStatus.textContent = '';
  }, () => {
    if (active && request === generation && closeStatus) closeStatus.textContent = t('blockedclosefailed');
  }).finally(() => {
    if (!active || request !== generation) return;
    pending = false;
    closeBtn.setAttribute('aria-disabled', 'false');
  });
});

async function closeCurrentTab() {
  const result = await browser.runtime.sendMessage({ type: 'close_current_tab' });
  if (result?.success !== true) throw new Error('Close was not confirmed');
}
