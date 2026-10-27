import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { openSoundOptions, requestSoundPreview } from '../e2e/sound-options.mjs';
import { focusSoundScenarios } from '../e2e/focus-sound-scenarios.mjs';

function fixture({ tainted = false, navigationError = '' } = {}) {
  const calls = [], options = [], world = {
    navigator: { userActivation: { hasBeenActive: false, isActive: false } },
    location: { href: 'about:blank' }, document: { readyState: 'complete' }
  };
  let detached = 0, evaluationError = null;
  const nativePage = {
    on() {},
    goto() { throw new Error('Framework navigation is outside the gesture-free channel'); },
    evaluate() { throw new Error('Playwright evaluate would create activation'); },
    locator(selector) { return { async click() { calls.push(['native-click', selector]); } }; }
  };
  const session = {
    async send(command, params) {
      calls.push([command, params]);
      if (command === 'Page.enable') return {};
      if (command === 'Page.navigate') {
        world.location.href = params.url; world.navigator.userActivation.hasBeenActive = tainted;
        return { errorText: navigationError || undefined };
      }
      assert.equal(command, 'Runtime.evaluate');
      assert.equal(params.userGesture, false); assert.equal(params.awaitPromise, true); assert.equal(params.returnByValue, true);
      if (evaluationError) return { exceptionDetails: { text: evaluationError } };
      return { result: { value: await runInNewContext(params.expression, world) } };
    },
    async detach() { detached++; }
  };
  const e = { id: 'owned', options, result: {}, context: {
    async newPage() { return nativePage; },
    async newCDPSession(page) { assert.equal(page, nativePage); return session; }
  } };
  return { e, calls, options, world, nativePage, detached: () => detached,
    failEvaluation(message) { evaluationError = message; } };
}

test('native navigation, readiness and proof reads stay on the gesture-free channel', async () => {
  const f = fixture(), view = await openSoundOptions(f.e);
  assert.ok(f.calls.some(([command, params]) => command === 'Page.navigate' &&
    params.url === 'chrome-extension://owned/options/options.html'));
  assert.deepEqual(f.options, [f.nativePage]);
  assert.deepEqual(view.activation.map(item => [item.stage, item.sticky]),
    [['before-navigation', false], ['after-navigation', false]]);
  assert.equal(await view.page.evaluate(() => navigator.userActivation.hasBeenActive), false);
  assert.equal(await view.page.evaluate(async input => input.value, { value: 'quoted " value' }), 'quoted " value');
  await view.page.locator('#previewFocusSound').click();
  assert.ok(f.calls.some(call => call[0] === 'native-click'));
  await view.close(); await view.close(); assert.equal(f.detached(), 1);
});

test('a native evaluation exception is preserved and its session can still close', async () => {
  const f = fixture(), view = await openSoundOptions(f.e);
  f.failEvaluation('native failure');
  await assert.rejects(view.page.evaluate(() => 1), /native failure/);
  await view.close(); assert.equal(f.detached(), 1);
});

test('navigation failure saves its activation evidence and releases the native session', async () => {
  const f = fixture({ navigationError: 'ERR_BLOCKED_BY_CLIENT' });
  await assert.rejects(openSoundOptions(f.e), /ERR_BLOCKED_BY_CLIENT/);
  assert.equal(f.e.result.soundOptionsActivation.length, 1);
  assert.equal(f.detached(), 1);
});

test('observed user activation remains a failing precondition before either sound scenario can play', async () => {
  for (const scenario of focusSoundScenarios) {
    const f = fixture({ tainted: true });
    await assert.rejects(scenario.run(f.e), error => error.name === 'AssertionError' &&
      error.message.includes('after-navigation'));
    assert.equal(f.e.result.focusSoundEvidence.activation.find(item => item.stage === 'after-navigation').sticky, true);
    assert.equal(f.detached(), 1);
    assert.ok(!f.calls.some(([command, params]) => command === 'Runtime.evaluate' &&
      params.expression.includes('runtime.sendMessage')));
  }
});

test('Firefox retains native BiDi reads and records its unmodified activation state', async () => {
  const nativePage = { async evaluate() { return { sticky: false, transient: false, url: 'moz-extension://owned/options/options.html' }; } };
  let opened = 0;
  const view = await openSoundOptions({ async openOptions() { opened++; return nativePage; } });
  assert.equal(view.page, nativePage); assert.equal(opened, 1);
  assert.equal(view.activation[0].stage, 'options-ready');
  assert.equal(view.activation[0].sticky, false); await view.close();
});

test('activation appearing after setup blocks the request in the same evaluation that would send it', async () => {
  const f = fixture(), view = await openSoundOptions(f.e);
  let sent = 0;
  f.world.chrome = { runtime: { async sendMessage(message) {
    assert.equal(message.type, 'sound:preview'); sent++; return { success: true };
  } } };
  assert.equal((await view.page.evaluate(requestSoundPreview)).success, true);
  assert.equal(sent, 1, 'a clean document reaches the actual message producer');
  f.world.navigator.userActivation.hasBeenActive = true;
  await assert.rejects(view.page.evaluate(requestSoundPreview), /acquired content activation/);
  assert.equal(sent, 1, 'a later activation cannot slip between proof and request');
  await view.close();
});
