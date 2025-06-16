export function t(key) {
  return browser.i18n.getMessage(key) || key;
}