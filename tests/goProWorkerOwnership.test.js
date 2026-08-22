import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeDocument,
  createExtensionApi,
  withExtensionEnvironment
} from './helpers/extensionTestHarness.js';

let goProImportId = 0;

async function withGoProPage({
  isPro = false,
  workerResponse = { success: true },
  settings = {}
} = {}, callback) {
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
      settings: { enablePassword: false, debugMode: false, ...settings },
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
  let reloadCount = 0;
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
        credentialWrites,
        getReloadCount: () => reloadCount
      });
    }, {
      document,
      window: { location: { reload() { reloadCount += 1; } } }
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

test('verified protected logout clears the password hash after the worker ends the Pro session', async () => {
  await withGoProPage({
    isPro: true,
    settings: {
      enablePassword: true,
      passwordHash: 'salt:private-hash',
      mode: 'strict',
      focusSessionSound: true
    }
  }, async ({ api, logout, statusMessages, credentialWrites, getReloadCount }) => {
    const { PasswordUtils } = await import('../pro/password.js');
    const original = PasswordUtils.showPasswordModal;
    let verificationCalls = 0;
    PasswordUtils.showPasswordModal = (type, callback) => {
      verificationCalls += 1;
      assert.equal(type, 'verify');
      callback(true);
    };

    try {
      await logout.dispatch('click');

      assert.equal(verificationCalls, 1);
      assert.equal(statusMessages.length, 1);
      assert.equal(statusMessages[0].isPro, false);
      assert.deepEqual(credentialWrites, []);
      assert.equal(api.storage.sync.data.credentials.isPro, false);
      assert.equal(api.storage.sync.data.settings.enablePassword, false);
      assert.equal(api.storage.sync.data.settings.passwordHash, null);
      assert.equal(api.storage.sync.data.settings.mode, 'strict');
      assert.equal(api.storage.sync.data.settings.focusSessionSound, true);
      assert.equal(getReloadCount(), 1);
    } finally {
      PasswordUtils.showPasswordModal = original;
    }
  });
});

test('cancelled protected logout never sends a downgrade request to the service worker', async () => {
  await withGoProPage({
    isPro: true,
    settings: { enablePassword: true, passwordHash: 'salt:private-hash' }
  }, async ({ api, logout, statusMessages, getReloadCount }) => {
    const { PasswordUtils } = await import('../pro/password.js');
    const original = PasswordUtils.showPasswordModal;
    PasswordUtils.showPasswordModal = (_type, callback) => callback(false);

    try {
      await logout.dispatch('click');

      assert.deepEqual(statusMessages, []);
      assert.equal(api.storage.sync.data.credentials.isPro, true);
      assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-EXISTING-KEY');
      assert.equal(api.storage.sync.data.settings.enablePassword, true);
      assert.equal(api.storage.sync.data.settings.passwordHash, 'salt:private-hash');
      assert.equal(getReloadCount(), 0);
    } finally {
      PasswordUtils.showPasswordModal = original;
    }
  });
});

test('logout fails closed if security settings cannot be read', async () => {
  await withGoProPage({
    isPro: true,
    settings: { enablePassword: true, passwordHash: 'salt:private-hash' }
  }, async ({ api, logout, message, statusMessages, getReloadCount }) => {
    const originalGet = api.storage.sync.get.bind(api.storage.sync);
    api.storage.sync.get = (keys, callback) => {
      if (Array.isArray(keys) && keys.includes('settings')) {
        return Promise.reject(new Error('password settings unavailable'));
      }
      return originalGet(keys, callback);
    };

    await logout.dispatch('click');

    assert.deepEqual(statusMessages, []);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-EXISTING-KEY');
    assert.equal(api.storage.sync.data.settings.enablePassword, true);
    assert.equal(message.textContent, 'loggedouterror');
    assert.match(message.className, /error/);
    assert.equal(getReloadCount(), 0);
  });
});

test('logout fails closed if security settings initialization cannot be persisted', async () => {
  await withGoProPage({ isPro: true }, async ({ api, logout, message, statusMessages }) => {
    delete api.storage.sync.data.settings;
    api.storage.sync.setError = new Error('settings initialization rejected');

    await logout.dispatch('click');

    assert.deepEqual(statusMessages, []);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal('settings' in api.storage.sync.data, false);
    assert.equal(message.textContent, 'loggedouterror');
  });
});

test('logout fails closed when the password verification modal cannot open', async () => {
  await withGoProPage({
    isPro: true,
    settings: { enablePassword: true, passwordHash: 'salt:private-hash' }
  }, async ({ api, logout, message, statusMessages }) => {
    const { PasswordUtils } = await import('../pro/password.js');
    const original = PasswordUtils.showPasswordModal;
    PasswordUtils.showPasswordModal = () => {
      throw new Error('password modal unavailable');
    };

    try {
      await logout.dispatch('click');

      assert.deepEqual(statusMessages, []);
      assert.equal(api.storage.sync.data.credentials.isPro, true);
      assert.equal(api.storage.sync.data.settings.enablePassword, true);
      assert.equal(message.textContent, 'loggedouterror');
    } finally {
      PasswordUtils.showPasswordModal = original;
    }
  });
});

test('failed worker logout keeps an already-verified password and Pro access intact', async () => {
  await withGoProPage({
    isPro: true,
    workerResponse: { success: false, error: 'Worker unavailable' },
    settings: { enablePassword: true, passwordHash: 'salt:private-hash' }
  }, async ({ api, logout, message, statusMessages, getReloadCount }) => {
    const { PasswordUtils } = await import('../pro/password.js');
    const original = PasswordUtils.showPasswordModal;
    PasswordUtils.showPasswordModal = (_type, callback) => callback(true);

    try {
      await logout.dispatch('click');

      assert.equal(statusMessages.length, 1);
      assert.equal(api.storage.sync.data.credentials.isPro, true);
      assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-EXISTING-KEY');
      assert.equal(api.storage.sync.data.settings.enablePassword, true);
      assert.equal(api.storage.sync.data.settings.passwordHash, 'salt:private-hash');
      assert.equal(message.textContent, 'loggedouterror');
      assert.equal(getReloadCount(), 0);
    } finally {
      PasswordUtils.showPasswordModal = original;
    }
  });
});
