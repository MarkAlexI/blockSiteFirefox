// Classic WebDriver does not select a replacement after close(). BiDi can
// still create/read live tabs while the Classic current handle is discarded.
export async function selectLiveWindow(driver, target, NoSuchWindowError) {
  let selected = null;
  try { selected = await driver.getWindowHandle(); }
  catch (error) {
    if (!(error instanceof NoSuchWindowError)) throw error;
  }
  if (selected === target) return false;
  await driver.switchTo().window(target);
  return true;
}
