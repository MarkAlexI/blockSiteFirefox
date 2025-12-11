export function isBlockedURL(tabs) {
  if (!tabs) return true;
  const url = tabs[0]?.url || '';
  
  const blockedPatterns = [
    /^about:/,
    /^moz-extension:\/\//,
    /^https:\/\/addons\.mozilla\.org\//,
    /^devtools:/
  ];
  
  return blockedPatterns.some(pattern => pattern.test(url));
}