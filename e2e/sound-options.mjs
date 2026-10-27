// Keep navigation and evaluation on the same gesture-free CDP channel.
// Playwright page.evaluate supplies userGesture:true. The activation trace
// records each real document state; it never clears or replaces that state.
export async function requestSoundPreview() {
  if (navigator.userActivation.hasBeenActive) {
    throw new Error('Sound preview acquired content activation before its request');
  }
  return (globalThis.browser || chrome).runtime.sendMessage({ type: 'sound:preview' });
}

export async function openSoundOptions(e) {
  const activation = [];
  const capture = page => async stage => {
    const value = await page.evaluate(() => ({
      sticky: navigator.userActivation.hasBeenActive,
      transient: navigator.userActivation.isActive,
      at: Date.now(), url: location.href
    }));
    activation.push({ stage, ...value });
    return value;
  };
  if (!e.context?.newCDPSession) {
    const page = await e.openOptions();
    const captureActivation = capture(page);
    await captureActivation('options-ready');
    return { page, activation, captureActivation, close: async () => {} };
  }
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
  const facade = { evaluate, locator: selector => page.locator(selector) };
  const captureActivation = capture(facade);
  let detached = false;
  const close = async () => { if (!detached) { detached = true; await session.detach(); } };
  try {
    page.on?.('pageerror', error => e.pageErrors?.push(error.message));
    await captureActivation('before-navigation');
    const url = `chrome-extension://${e.id}/options/options.html`;
    await session.send('Page.enable');
    const navigation = await session.send('Page.navigate', { url });
    if (navigation.errorText) throw new Error(`Sound Options navigation: ${navigation.errorText}`);
    const deadline = Date.now() + 15000;
    for (;;) {
      let ready = false;
      try {
        ready = await evaluate(url => location.href === url && document.readyState === 'complete', url);
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(error.message)) throw error;
      }
      if (ready) break;
      if (Date.now() >= deadline) throw new Error('Native Sound Options document did not finish loading');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    e.options?.push(page);
    await captureActivation('after-navigation');
    return { page: facade, activation, captureActivation, close };
  } catch (error) {
    if (e.result) e.result.soundOptionsActivation = activation;
    try { await e.testInfo?.attach('sound-options-activation', {
      body: JSON.stringify(activation, null, 2), contentType: 'application/json'
    }); } catch { /* Preserve the original setup failure. */ }
    await close(); throw error;
  }
}
