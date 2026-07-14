export async function updateUninstallURL() {
  const { credentials } = await browser.storage.sync.get(['credentials']);
  const { rules } = await browser.storage.local.get(['rules']);

  const rawData = JSON.stringify({
    l: credentials?.isLegacyUser ?? null,
    d: credentials?.installationDate ?? null,
    p: credentials?.isPro ?? null,
    v: browser.runtime.getManifest().version ?? null,
    r: rules?.length ?? null
  });

  const encodedData = btoa(unescape(encodeURIComponent(rawData)));
  
  browser.runtime.setUninstallURL(`https://blockdistraction.com/uninstall.html?ctx=${encodedData}`);
}
