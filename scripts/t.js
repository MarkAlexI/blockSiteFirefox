export function t(key1, key2) {
  if (key2) {
    return browser.i18n.getMessage(key1, key2) || key1;
  }
  
  return browser.i18n.getMessage(key1) || key1;
}