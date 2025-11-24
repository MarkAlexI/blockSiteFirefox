/**
 * Wrapper for browser.i18n.getMessage
 * @param {string} key - The key from messages.json
 * @param {string|number|Array} [substitutions] - Optional replacement strings
 * @returns {string} Localized string
 */
export function t(key, substitutions) {
  if (substitutions !== undefined && substitutions !== null) {
    const args = Array.isArray(substitutions) ?
      substitutions.map(String) :
      [String(substitutions)];
    
    return browser.i18n.getMessage(key, args) || key;
  }
  
  return browser.i18n.getMessage(key) || key;
}