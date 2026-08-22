import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeDocument,
  createExtensionApi,
  withExtensionEnvironment
} from './helpers/extensionTestHarness.js';

let goProImportId = 0;

async function withGoProPage({ isPro = false, workerResponse = { success: true } } = {}, callback) {
  const document = new FakeDocument();
  document.addElement('proBtnText');
  document.addElement('pro-activate-view');
  document.addElement('pro-active-view');
  const form = document.addElement('license-form', 'form');
  const input = document.addElement('license-key-input', 'input');
  const submit = document.addElement('license-submit-btn', 'button');
  const message = document.addElement('license-message');
  const logout = document.addElement('log-out-btn', 'button');
  document.addElement('pro-section');
  document.addElement('header-text');
  const api = createExtensionApi({
    sync: {
      settings: { enablePassword: false, debugMode: false },
      credentials: {
        isPro,
        licenseKey: isPro ? 'BD-EXISTING-KEY' : null,
        installationDate: '2026-08-01T00:00:00.000Z'
      }
    }
  });
  const statusMessages = [];
  api.runtime.onMessage = { addListener() {} };
  api.runtime.sendMessage = (request, respond) => {
    statusMessages.push(structuredClone(request));
    if (workerResponse?.success === true && request.type === 'update_pro_status') {
      api.storage.sync.data.credentials = {
        ...api.storage.sync.data.credentials,
        ...request.subscriptionData,
        isPro: request.isPro
      };
    }
    if (typeof respond === 'function') respond(workerResponse);
    return Promise.resolve(workerResponse);
  };

  const credentialWrites = [];
  const originalSet = api.storage.sync.set.bind(api.storage.sync);
  api.storage.sync.set = values => {
    if (values.credentials) credentialWrites.push(structuredClone(values.credentials));
    return originalSet(values);
  };

  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const previousConsoleError = console.error;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      isPro: true,
      email: 'person@example.com',
      expiryDate: '2027-08-01'
    })
  });
  globalThis.setTimeout = () => 1;
  console.error = () => {};

  try {
    await withExtensionEnvironment(api, async () => {
      goProImportId += 1;
      await import('../options/goPro.js?workerOwnership=' + goProImportId);
      await callback({
        api,
        document,
        form,
        input,
        submit,
        message,
        logout,
        statusMessages,
        credentialWrites
      });
    }, {
      document,
      window: { location: { reload() {} } }
    });
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    console.error = previousConsoleError;
  }
}

test('license activation delegates its only credentials mutation to the service worker', async () => {
  await withGoProPage({}, async ({ api, form, input, message, statusMessages, credentialWrites }) => {
    input.value = 'BD-NEW-KEY';
    await form.dispatch('submit');

    assert.equal(statusMessages.length, 1);
    assert.deepEqual(statusMessages[0], {
      type: 'update_pro_status',
      isPro: true,
      subscriptionData: {
        licenseKey: 'BD-NEW-KEY',
        subscriptionEmail: 'person@example.com',
        expiryDate: '2027-08-01'
      }
    });
    assert.deepEqual(credentialWrites, []);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(message.textContent, 'proactivated');
  });
});

test('logout delegates its only credentials mutation to the service worker', async () => {
  await withGoProPage({ isPro: true }, async ({
    api, logout, message, statusMessages, credentialWrites
  }) => {
    await logout.dispatch('click');

    assert.equal(statusMessages.length, 1);
    assert.equal(statusMessages[0].type, 'update_pro_status');
    assert.equal(statusMessages[0].isPro, false);
    assert.deepEqual(credentialWrites, []);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    assert.equal(message.textContent, 'loggedoutsuccess');
  });
});

test('failed worker activation never creates a local Pro session', async () => {
  await withGoProPage({
    workerResponse: { success: false, error: 'Worker unavailable' }
  }, async ({ api, form, input, message, credentialWrites }) => {
    input.value = 'BD-REJECTED-KEY';
    await form.dispatch('submit');

    assert.deepEqual(credentialWrites, []);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
    assert.equal(message.textContent, 'subscriptionnotfound');
  });
});

test('failed worker logout leaves the current Pro credentials untouched', async () => {
  await withGoProPage({
    isPro: true,
    workerResponse: { success: false, error: 'Worker unavailable' }
  }, async ({ api, logout, message, credentialWrites }) => {
    await logout.dispatch('click');

    assert.deepEqual(credentialWrites, []);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-EXISTING-KEY');
    assert.equal(message.textContent, 'loggedouterror');
  });
});
