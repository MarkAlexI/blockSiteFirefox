export function createInstallURL() {
  const url = browser.runtime.getURL('options/options.html');
  
  return url;
}