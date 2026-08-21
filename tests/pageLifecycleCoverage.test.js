import test from 'node:test';
import assert from 'node:assert/strict';

import { IS_FIREFOX } from '../utils/constants.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

test('the blocked page closes through the platform-appropriate browser mechanism', async () => {
  const document = new FakeDocument();
  const closeButton = document.addElement('closeBtn', 'button');
  const api = createExtensionApi();
  let closed = 0;

  await withExtensionEnvironment(api, async () => {
    await import('../scripts/blocked.js');
    await closeButton.dispatch('click');

    if (IS_FIREFOX) {
      assert.deepEqual(api.messages, [{ type: 'close_current_tab' }]);
      assert.equal(closed, 0);
      api.runtime.sendMessage = () => { throw new Error('worker unavailable'); };
      await assert.doesNotReject(closeButton.dispatch('click'));
    } else {
      assert.equal(closed, 1);
      assert.deepEqual(api.messages, []);
    }
  }, {
    document,
    window: { close() { closed += 1; } }
  });
});

let redirectImportId = 0;

async function exerciseRedirect(href, configureApi = null) {
  const api = createExtensionApi();
  if (configureApi) configureApi(api);
  const redirected = [];
  const location = {
    href,
    replace(url) { redirected.push(url); }
  };
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousError = console.error;
  globalThis.location = location;
  console.error = () => {};

  try {
    await withExtensionEnvironment(api, async () => {
      const suffix = redirectImportId++ === 0 ? '' : `?case=${redirectImportId}`;
      await import(`../scripts/redirect.js${suffix}`);
    }, { window: { location } });
  } finally {
    console.error = previousError;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  }

  return { api, redirected };
}

test('redirect pages record the source and add HTTPS to destinations without a scheme', async () => {
  const source = encodeURIComponent('https://source.example/team');
  const destination = encodeURIComponent('target.example/path');
  const result = await exerciseRedirect(`https://extension.example/redirect.html?from=${source}&to=${destination}`);
  assert.deepEqual(result.api.messages, [{
    type: 'record_redirect',
    from: 'https://source.example/team',
    to: 'target.example/path'
  }]);
  assert.deepEqual(result.redirected, ['https://target.example/path']);
});

test('redirect pages preserve explicit HTTPS destinations and skip incomplete requests', async () => {
  const valid = await exerciseRedirect(
    'https://extension.example/redirect.html?from=https%3A%2F%2Fsource.example%2F&to=https%3A%2F%2Fsafe.example%2F'
  );
  assert.deepEqual(valid.redirected, ['https://safe.example/']);

  const incomplete = await exerciseRedirect('https://extension.example/redirect.html?from=https%3A%2F%2Fsource.example%2F');
  assert.deepEqual(incomplete.redirected, []);
  assert.deepEqual(incomplete.api.messages, []);
});

test('redirect delivery failures do not prevent navigation to the requested safe destination', async () => {
  const result = await exerciseRedirect(
    'https://extension.example/redirect.html?from=https%3A%2F%2Fsource.example%2F&to=safe.example',
    api => { api.runtime.sendMessage = () => { throw new Error('worker unavailable'); }; }
  );
  assert.deepEqual(result.redirected, ['https://safe.example']);
});

test('an invalid redirect-page URL falls back to the packaged blocked page', async () => {
  const result = await exerciseRedirect('not a valid URL');
  assert.deepEqual(result.redirected, ['extension://test-extension-id/blocked.html']);
});
