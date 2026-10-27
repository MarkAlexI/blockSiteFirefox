import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { openSoundOptions } from '../e2e/sound-options.mjs';

test('the Chromium sound view starts in a fresh document and all proof reads explicitly avoid user activation', async () => {
  const calls = [], options = []; let detached = 0;
  const nativePage = { on() {}, async goto(url) { calls.push(['goto', url]); },
    locator(selector) { calls.push(['locator', selector]); return { async click() { calls.push(['native-click']); } }; },
    evaluate() { throw new Error('Playwright evaluate would create activation'); } };
  const session = { async send(command, params) {
    calls.push([command, params]);
    assert.equal(params.userGesture, false); assert.equal(params.awaitPromise, true); assert.equal(params.returnByValue, true);
    return { result: { value: await runInNewContext(params.expression, { navigator: { userActivation: { hasBeenActive: false } } }) } };
  }, async detach() { detached++; } };
  const view = await openSoundOptions({ id: 'owned', options,
    context: { async newPage() { return nativePage; }, async newCDPSession(page) { assert.equal(page, nativePage); return session; } } });
  assert.deepEqual(calls[0], ['goto', 'chrome-extension://owned/options/options.html']);
  assert.deepEqual(options, [nativePage]);
  assert.equal(await view.page.evaluate(() => navigator.userActivation.hasBeenActive), false);
  assert.equal(await view.page.evaluate(async input => input.value, { value: 'quoted " value' }), 'quoted " value');
  await view.page.locator('#previewFocusSound').click();
  assert.ok(calls.some(call => call[0] === 'native-click'));
  await view.close(); assert.equal(detached, 1);
});
test('a native evaluation exception is surfaced rather than becoming an empty success', async () => {
  const view = await openSoundOptions({ id: 'owned', context: {
    async newPage() { return { async goto() {}, locator() {} }; },
    async newCDPSession() { return { async send() { return { exceptionDetails: { text: 'native failure' } }; }, async detach() {} }; }
  } });
  await assert.rejects(view.page.evaluate(() => 1), /native failure/); await view.close();
});
test('Firefox retains its native BiDi Options path without requiring Chromium CDP', async () => {
  const nativePage = {}; let opened = 0;
  const view = await openSoundOptions({ async openOptions() { opened++; return nativePage; } });
  assert.equal(view.page, nativePage); assert.equal(opened, 1); await view.close();
});
