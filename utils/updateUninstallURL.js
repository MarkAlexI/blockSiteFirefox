export async function updateUninstallURL() {
  await browser.runtime.setUninstallURL('https://blockdistraction.com/uninstall.html');
}
