import test from 'node:test';
import assert from 'node:assert/strict';

import { IS_FIREFOX } from '../utils/constants.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

test('the blocked page closes through the platform-appropriate browser mechanism', async () => {
  const document = new FakeDocument();
  const closeButton = document.addElement('closeBtn', 'button');
  const api = createExtensionApi();
  let closed = 0;
  api.tabs.getCurrent = async () => ({ id: 73 });

  await withExtensionEnvironment(api, async () => {
    await import('../scripts/blocked.js');
    await closeButton.dispatch('click');
    await new Promise(resolve => setImmediate(resolve));

    if (IS_FIREFOX) {
      assert.deepEqual(api.messages, [{ type: 'close_current_tab' }]);
      assert.equal(closed, 0);
      api.runtime.sendMessage = () => { throw new Error('worker unavailable'); };
      await assert.doesNotReject(closeButton.dispatch('click'));
    } else {
      assert.equal(closed, 0);
      assert.deepEqual(api.removedTabs, [73]);
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
    api.tabs.getCurrent = async () => ({ id: 1, url: location.href });
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

function assertAuthorizationRequest(messages) {
  assert.equal(messages.length, 1);
  const { documentToken, ...request } = messages[0];
  assert.deepEqual(request, { type: 'record_redirect' });
  assert.match(documentToken, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
}

test('redirect pages request authorization rather than trusting scheme-less query targets', async () => {
  const source = encodeURIComponent('https://source.example/team');
  const destination = encodeURIComponent('target.example/path');
  const result = await exerciseRedirect(`https://extension.example/redirect.html?from=${source}&to=${destination}`);
  assertAuthorizationRequest(result.api.messages);
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
  assertAuthorizationRequest(valid.api.messages);

  const incomplete = await exerciseRedirect('https://extension.example/redirect.html?from=https%3A%2F%2Fsource.example%2F');
  assert.deepEqual(incomplete.redirected, ['extension://test-extension-id/blocked.html']);
  assertAuthorizationRequest(incomplete.api.messages);
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
