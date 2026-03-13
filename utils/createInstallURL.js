export function createInstallURL() {
  const base = "https://blockdistraction.com/index.html";
  
  const browser = "firefox";
  const version = browser.runtime.getManifest().version;
  
  const params = new URLSearchParams({
    src: "extension",
    browser: browser,
    ext_version: version
  });
  
  return `${base}?${params.toString()}`;
}