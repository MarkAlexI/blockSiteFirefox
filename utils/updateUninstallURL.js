export async function updateUninstallURL() {
  const { credentials, rules } = await browser.storage.sync.get(['credentials', 'rules']);

  const rawData = JSON.stringify({
    e: credentials?.subscriptionEmail ?? null,
    l: credentials?.isLegacyUser ?? null,
    d: credentials?.installationDate ?? null,
    p: credentials?.isPro ?? null,
    v: browser.runtime.getManifest().version ?? null,
    r: rules?.length ?? null
  });

  const encodedData = btoa(unescape(encodeURIComponent(rawData)));
  
  browser.runtime.setUninstallURL(`https://blockdistraction.com/uninstall.html?ctx=${encodedData}`);
}
