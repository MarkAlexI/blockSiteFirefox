export async function shouldSkipSync() {
  const data = await browser.storage.local.get(['lastCheck']);
  const now = Date.now();
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;

  if (data.lastCheck && (now - data.lastCheck < TWELVE_HOURS)) {
    return true;
  }
  
  return false;
}