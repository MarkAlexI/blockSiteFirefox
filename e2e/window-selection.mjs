// Classic WebDriver does not select a replacement after close(). BiDi can
// still create/read live tabs while the Classic current handle is discarded.
export async function selectLiveWindow(driver, target, NoSuchWindowError, { reselect = false } = {}) {
  let selected = null;
  try { selected = await driver.getWindowHandle(); }
  catch (error) {
    if (!(error instanceof NoSuchWindowError)) throw error;
  }
  // Native chrome actions and openOptionsPage can change real UI selection
  // without changing Classic WebDriver's current handle.
  if (selected === target && !reselect) return false;
  await driver.switchTo().window(target);
  return true;
}
