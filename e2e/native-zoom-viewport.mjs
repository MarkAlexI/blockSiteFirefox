import assert from 'node:assert/strict';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Configure a real browser window; do not emulate zoom with page styles. */
export async function setNativeZoomedViewport(page, initial, {
  evidence = [], now = Date.now, wait = pause
} = {}) {
  let requestedWidth = 640;
  await page.evaluate(async initial => {
    const api = typeof browser === 'undefined' ? chrome : browser;
    await api.windows.update(initial.windowId, { state: 'normal' });
    await api.tabs.setZoom(initial.tabId, 2);
    await api.windows.update(initial.windowId, { width: 640, height: 960 });
  }, initial);

  // Keep the original viewport deadline and acceptance range. Native window
  // bounds alone do not establish the content's CSS viewport after zoom.
  const deadline = now() + 15_000;
  let previous, last, stableReads = 0, corrections = 0;
  while (now() < deadline) {
    last = await page.evaluate(async initial => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const nativeWindow = await api.windows.get(initial.windowId);
      return { factor: await api.tabs.getZoom(initial.tabId), dpr: devicePixelRatio,
        innerWidth, innerHeight, outerWidth, outerHeight,
        windowWidth: nativeWindow.width, windowHeight: nativeWindow.height, state: nativeWindow.state,
        screenWidth: screen.availWidth, screenHeight: screen.availHeight };
    }, initial);
    const signature = JSON.stringify(last);
    stableReads = signature === previous ? stableReads + 1 : 0;
    previous = signature;
    if (stableReads >= 1 && last.factor === 2 && last.state === 'normal') {
      if (last.innerWidth >= 280 && last.innerWidth <= 340) {
        evidence.push({ requestedWidth, ...last });
        return last;
      }
      if (corrections < 3 && Number.isFinite(last.innerWidth) && last.innerWidth > 0) {
        evidence.push({ requestedWidth, ...last });
        const nextWidth = Math.round(requestedWidth * 320 / last.innerWidth);
        assert.ok(Number.isSafeInteger(nextWidth) && nextWidth > 0, 'Invalid native viewport correction');
        requestedWidth = nextWidth;
        await page.evaluate(async ({ windowId, width }) => {
          const api = typeof browser === 'undefined' ? chrome : browser;
          await api.windows.update(windowId, { width });
        }, { windowId: initial.windowId, width: requestedWidth });
        corrections++;
        previous = undefined;
        stableReads = 0;
      }
    }
    await wait(50);
  }
  evidence.push({ requestedWidth, ...last });
  assert.fail('Native 200% narrow viewport not reached: ' + JSON.stringify(evidence));
}
