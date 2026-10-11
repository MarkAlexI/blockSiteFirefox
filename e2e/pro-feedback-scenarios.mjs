import assert from 'node:assert/strict';
import { send, TEST_KEY } from './fixtures.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, check, label) {
  const deadline = Date.now() + 15_000;
  let last;
  do {
    last = await read();
    if (check(last)) return last;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}
const click = (page, selector) => page.locator ? page.locator(selector).click() : page.click(selector);
const fill = (page, selector, value) => page.locator ? page.locator(selector).fill(value) : page.fill(selector, value);

// Browser-owned layout, observed after each DOM mutation and on every rendered
// frame. Readiness polling below never discards an earlier clipped sample.
export function installProFeedbackObserver() {
  const wrapper = document.getElementById('proWrapper');
  const message = document.getElementById('license-message');
  const section = document.getElementById('pro-section');
  const view = window.__bdProFeedback = { samples: [], overflow: false, stopped: false, frame: null };
  view.sample = source => {
    const outer = wrapper.getBoundingClientRect();
    const rect = message.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(message);
    const text = range.getBoundingClientRect();
    const visible = getComputedStyle(message).display !== 'none' && rect.height > 0;
    const open = wrapper.classList.contains('open');
    const tolerance = 1;
    const fits = rect.top >= outer.top + wrapper.clientTop - tolerance &&
      rect.bottom <= outer.bottom - wrapper.clientTop + tolerance &&
      text.left >= rect.left - tolerance && text.right <= rect.right + tolerance;
    const sample = { source, at: performance.now(), open, visible, fits,
      error: message.classList.contains('error-message'), inert: wrapper.inert,
      maxHeight: wrapper.style.maxHeight, columnWidth: section.getBoundingClientRect().width,
      outer: { top: outer.top, bottom: outer.bottom },
      message: { top: rect.top, bottom: rect.bottom, text: message.textContent },
      focus: document.activeElement?.id || null };
    if (view.samples.length < 2000) view.samples.push(sample); else view.overflow = true;
    return sample;
  };
  view.observer = new MutationObserver(() => view.sample('mutation'));
  view.observer.observe(wrapper, { subtree: true, childList: true, attributes: true, characterData: true });
  const frame = () => {
    if (view.stopped) return;
    view.sample('frame');
    view.frame = requestAnimationFrame(frame);
  };
  view.frame = requestAnimationFrame(frame);
  view.sample('installed');
}

async function broadcastStatus(e, isPro) {
  if (e.worker) {
    await e.worker.evaluate(async isPro => {
      await chrome.runtime.sendMessage({ type: 'pro_status_changed', isPro }).catch(() => {});
    }, isPro);
  } else {
    await e.probe.evaluate(async isPro => {
      const background = await browser.runtime.getBackgroundPage();
      await background.browser.runtime.sendMessage({ type: 'pro_status_changed', isPro }).catch(() => {});
    }, isPro);
  }
}

export const proFeedbackScenarios = [{
  id: '47',
  title: 'Pro feedback remains fully visible after status refresh and narrow-column resize without stale clipped frames',
  async run(e) {
    // Grant Firefox's real user-action consent before the failed-key fixture.
    if (e.ensureLicenseConsent) await e.ensureLicenseConsent(await e.openOptions());
    await e.seed({ pro: false });
    const page = await e.openOptions();
    const evidence = { widths: [], verification: null, history: null };
    await page.evaluate(() => { document.getElementById('pro-section').style.maxWidth = '640px'; });
    await click(page, '#proBtn');
    await eventually(() => page.evaluate(() => {
      const panel = document.getElementById('proWrapper');
      return panel.classList.contains('open') && panel.style.maxHeight === 'none';
    }), Boolean, 'opening transition completed');
    await page.evaluate(installProFeedbackObserver);
    try {
      for (const pro of [true, false]) {
        await e.seed({ pro });
        await broadcastStatus(e, pro);
        await eventually(() => page.evaluate(pro => {
          const view = document.getElementById(pro ? 'pro-active-view' : 'pro-activate-view');
          return !view.hidden && getComputedStyle(view).display !== 'none';
        }, pro), Boolean, `native status refresh rendered ${pro ? 'Pro' : 'Free'}`);
        assert.equal(await page.evaluate(() => document.getElementById('proWrapper').style.maxHeight),
          'none', 'status refresh must not leave a fixed height even when no transitionend follows');
      }
      const before = await e.state();
      const calls = e.verificationCalls.length;
      e.verificationHandler = async () => ({ status: 404, body: { error: 'Invalid fixture key' } });
      await fill(page, '#license-key-input', TEST_KEY);
      await click(page, '#license-submit-btn');
      await eventually(() => page.evaluate(() => {
        const message = document.getElementById('license-message');
        return message.classList.contains('error-message') && message.classList.contains('show');
      }), Boolean, 'failed activation rendered');
      evidence.verification = { before: calls, after: e.verificationCalls.length };
      assert.equal(evidence.verification.after, calls + 1, 'one native verification request');
      for (const width of [340, 640]) {
        const observed = await page.evaluate(async width => {
          document.getElementById('pro-section').style.maxWidth = `${width}px`;
          const immediate = window.__bdProFeedback.sample('resize');
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { width, immediate, rendered: window.__bdProFeedback.sample('resize-rendered') };
        }, width);
        evidence.widths.push(observed);
        assert.ok(observed.immediate.visible && observed.immediate.error && observed.immediate.fits,
          'feedback must fit immediately after changing the column width');
        assert.ok(observed.rendered.visible && observed.rendered.error && observed.rendered.fits,
          'feedback must fit the rendered layout');
        assert.ok(observed.rendered.columnWidth <= width + 1, 'the requested narrow column was exercised');
      }
      const after = await e.state();
      assert.deepEqual(after.credentials, before.credentials, 'invalid activation cannot create Pro');
      assert.deepEqual(after.rules, before.rules, 'feedback must not change rules');
      assert.deepEqual(after.dailyRuleUsage, before.dailyRuleUsage, 'feedback must not change usage');
      assert.equal(await page.evaluate(() => document.getElementById('license-key-input').value), TEST_KEY,
        'failed activation retains input for retry');
      await click(page, '#proBtn');
      assert.deepEqual(await page.evaluate(() => ({
        open: document.getElementById('proWrapper').classList.contains('open'),
        inert: document.getElementById('proWrapper').inert,
        expanded: document.getElementById('proBtn').getAttribute('aria-expanded')
      })), { open: false, inert: true, expanded: 'false' });
    } finally {
      evidence.history = await page.evaluate(() => {
        const view = window.__bdProFeedback;
        view.stopped = true; view.observer.disconnect(); cancelAnimationFrame(view.frame);
        return { samples: view.samples, overflow: view.overflow };
      });
      if (e.testInfo) await e.testInfo.attach('pro-feedback-history', {
        contentType: 'application/json', body: JSON.stringify(evidence, null, 2)
      });
      else e.result.proFeedback = evidence;
    }
    assert.equal(evidence.history.overflow, false, 'feedback history is complete');
    const feedback = evidence.history.samples.filter(sample => sample.open && sample.visible);
    assert.ok(feedback.some(sample => sample.source === 'mutation' && sample.error), 'error mutation was observed');
    assert.ok(feedback.some(sample => sample.source === 'frame' && sample.error), 'error render was observed');
    assert.deepEqual(feedback.filter(sample => !sample.fits || sample.inert), [], 'no observed clipped feedback while open');
  }
}];
