// A menu tab and an Android action must keep their responsive page layout.
// Native view identity avoids guessing from the current viewport's width.
export async function initializePopupLayout(api, view) {
  const body = view?.document?.body;
  if (!body) return 'page';
  const selectSurface = surface => {
    body.dataset.popupSurface = surface;
    return surface;
  };
  try {
    const navigator = view.navigator || {};
    if (/Android/i.test(`${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`)) return selectSurface('page');
    if (!api?.extension?.getViews?.({ type: 'popup' }).includes(view)) return selectSurface('page');
    const platform = await api.runtime.getPlatformInfo();
    if (view.closed || !['win', 'mac', 'linux', 'cros', 'openbsd', 'fuchsia'].includes(platform?.os)) return selectSurface('page');
    return selectSurface('toolbar');
  } catch {
    // Layout detection must never prevent opening the menu or editing rules.
    return selectSurface('page');
  }
}

if (typeof window !== 'undefined') void initializePopupLayout(globalThis.browser || globalThis.chrome, window);
