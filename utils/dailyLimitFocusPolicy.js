// Android browsers can expose a desktop-shaped Windows API without a usable
// focused window. Their active page's native visibility owns accounting.
export function createDailyLimitFocusPolicy({ runtimeApi, navigatorRef = {} } = {}) {
  let required = /Android/i.test(`${navigatorRef.userAgentData?.platform || ''} ${navigatorRef.platform || ''} ${navigatorRef.userAgent || ''}`)
    ? false : undefined;
  let pending;
  return function requiresWindowFocus() {
    if (required !== undefined) return required;
    // The native platform also recognizes Android when desktop-site mode
    // presents a desktop user agent. Unknown platforms retain desktop checks.
    pending ??= Promise.resolve().then(async () => {
      try {
        if (typeof runtimeApi?.getPlatformInfo === 'function') {
          required = (await runtimeApi.getPlatformInfo())?.os !== 'android';
          return required;
        }
      } catch { /* Keep the conservative desktop policy if detection fails. */ }
      required = true;
      return required;
    });
    return pending;
  };
}
