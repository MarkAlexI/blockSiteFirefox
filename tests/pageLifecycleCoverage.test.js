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

let blockedPageImportId = 0;

async function getBlockedReasonMessageKey(reason) {
  const document = new FakeDocument();
  document.addElement('closeBtn', 'button');
  const reasonElement = document.addElement('blockedReason', 'p');
  reasonElement.setAttribute('data-i18n', 'blockedtext');
  const query = reason === null ? '' : `?reason=${encodeURIComponent(reason)}`;

  await withExtensionEnvironment(createExtensionApi(), async () => {
    blockedPageImportId += 1;
    await import(`../scripts/blocked.js?reason=${blockedPageImportId}`);
  }, {
    document,
    window: {
      close() {},
      location: { href: `extension://test-extension-id/blocked.html${query}` }
    }
  });

  return reasonElement.getAttribute('data-i18n');
}

test('the blocked page selects a localized message for each safe blocking reason', async () => {
  const expectedKeys = {
    always: 'blocking_mode_always',
    schedule: 'rule_scheduled',
    daily_limit: 'daily_limit_reached',
    focus: 'focussessionheader'
  };

  for (const [reason, messageKey] of Object.entries(expectedKeys)) {
    assert.equal(await getBlockedReasonMessageKey(reason), messageKey);
  }
});

test('the blocked page keeps its generic message for missing or unknown reasons', async () => {
  assert.equal(await getBlockedReasonMessageKey(null), 'blockedtext');
  assert.equal(await getBlockedReasonMessageKey('unknown'), 'blockedtext');
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
      await new Promise(resolve => setImmediate(resolve));
    }, { window: { location } });
  } finally {
    console.error = previousError;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  }

  return { api, redirected };
}

test('redirect pages request authorization rather than trusting scheme-less query targets', async () => {
  const source = encodeURIComponent('https://source.example/team');
  const destination = encodeURIComponent('target.example/path');
  const result = await exerciseRedirect(`https://extension.example/redirect.html?from=${source}&to=${destination}`);
  assert.deepEqual(result.api.messages, [{ type: 'record_redirect' }]);
  assert.deepEqual(result.redirected, ['extension://test-extension-id/blocked.html']);
});

test('redirect pages use verified HTTPS destinations and reject incomplete requests', async () => {
  const valid = await exerciseRedirect(
    'https://extension.example/redirect.html?from=https%3A%2F%2Fsource.example%2F&to=https%3A%2F%2Fsafe.example%2F',
    api => {
      api.runtime.sendMessage = message => {
        api.messages.push(message);
        return Promise.resolve({ success: true, to: 'https://safe.example/' });
      };
    }
  );
  assert.deepEqual(valid.redirected, ['https://safe.example/']);
  assert.deepEqual(valid.api.messages, [{ type: 'record_redirect' }]);

  const incomplete = await exerciseRedirect('https://extension.example/redirect.html?from=https%3A%2F%2Fsource.example%2F');
  assert.deepEqual(incomplete.redirected, ['extension://test-extension-id/blocked.html']);
  assert.deepEqual(incomplete.api.messages, [{ type: 'record_redirect' }]);
});

test('redirect delivery failures fall back to the packaged blocked page', async () => {
  const result = await exerciseRedirect(
    'https://extension.example/redirect.html?from=https%3A%2F%2Fsource.example%2F&to=safe.example',
    api => { api.runtime.sendMessage = () => { throw new Error('worker unavailable'); }; }
  );
  assert.deepEqual(result.redirected, ['extension://test-extension-id/blocked.html']);
});

test('an invalid redirect-page URL falls back to the packaged blocked page', async () => {
  const result = await exerciseRedirect('not a valid URL');
  assert.deepEqual(result.redirected, ['extension://test-extension-id/blocked.html']);
});
