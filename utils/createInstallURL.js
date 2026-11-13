import { IS_FIREFOX } from './constants.js';

export function createInstallURL(runtimeApi = globalThis.chrome?.runtime || globalThis.browser?.runtime) {
  return runtimeApi.getURL('options/options.html');
}

export async function openInstallPage({ runtimeApi, tabsApi, step, onFallback = () => {} }) {
  // Use Firefox's Options routing instead of choosing a current browser window.
  // Chromium/Edge retain direct tab creation, including the Edge Android workaround.
  if (IS_FIREFOX && typeof runtimeApi.openOptionsPage === 'function') {
    try {
      return await step('open_install_options', () => runtimeApi.openOptionsPage());
    } catch (error) {
      // Diagnostic persistence must not prevent the one fallback attempt.
      try { await onFallback(error); } catch { /* best effort */ }
    }
  }
  const url = await step('install_url', () => createInstallURL(runtimeApi));
  return step('open_install_page', () => tabsApi.create({ url, active: true }));
}
