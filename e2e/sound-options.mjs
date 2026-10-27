// Playwright's page.evaluate uses userGesture:true. A new document plus an
// explicit native CDP evaluation is required to test activation-free playback;
// reading hasBeenActive with page.evaluate would itself invalidate the proof.
export async function openSoundOptions(e) {
  if (!e.context?.newCDPSession) return { page: await e.openOptions(), close: async () => {} };
  const page = await e.context.newPage();
  const session = await e.context.newCDPSession(page);
  const evaluate = async (fn, input = null) => {
    const result = await session.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${JSON.stringify(input)})`,
      userGesture: false, awaitPromise: true, returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    page.on?.('pageerror', error => e.pageErrors?.push(error.message));
    await page.goto(`chrome-extension://${e.id}/options/options.html`);
    e.options?.push(page);
    return { page: { evaluate, locator: selector => page.locator(selector) }, close: () => session.detach() };
  } catch (error) {
    await session.detach(); throw error;
  }
}
