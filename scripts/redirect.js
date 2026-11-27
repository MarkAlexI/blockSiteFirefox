import './i18n.js';
import Logger from '../utils/logger.js';

const logger = new Logger('Redirect');

let active = true;
const initialHref = location.href;
window.addEventListener?.('pagehide', () => { active = false; });
const isCurrentPage = () => active && location.href === initialHref;

async function redirect() {
  let target = browser.runtime.getURL('blocked.html');
  try {
    const response = await browser.runtime.sendMessage({ type: 'record_redirect', documentToken: globalThis.crypto?.randomUUID?.() });
    if (!isCurrentPage() || response?.obsolete === true) return;
    const destination = response?.success === true && typeof response.to === 'string'
      ? new URL(response.to) : null;
    if (destination && (destination.protocol === 'http:' || destination.protocol === 'https:')) target = destination.href;
  } catch {
    logger.info('Redirect authorization was not available.');
  }
  if (!isCurrentPage()) return;
  try {
    // A user navigation may start while the worker checkpoints its decision.
    // Re-read this tab immediately before either the redirect or local fallback.
    const tab = await browser.tabs.getCurrent();
    if (isCurrentPage() && tab?.url === initialHref && (!tab.pendingUrl || tab.pendingUrl === initialHref)) {
      location.replace(target);
    }
  } catch { logger.info('Redirect tab was no longer available.'); }
}

redirect();
