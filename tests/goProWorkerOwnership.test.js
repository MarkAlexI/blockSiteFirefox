import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeDocument,
  createExtensionApi,
  withExtensionEnvironment
} from './helpers/extensionTestHarness.js';
import { LICENSE_SYNC_TIMEOUT_MS, VERIFY_API_URL } from '../utils/constants.js';

let goProImportId = 0;

async function withGoProPage({
  isPro = false,
  workerResponse = { success: true },
  settings = {},
  fetchHandler = null
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
  const workerRequests = [];
  api.runtime.onMessage = { addListener() {} };
  api.runtime.sendMessage = (request, respond) => {
    workerRequests.push(structuredClone(request));

    const operation = (async () => {
      if (request.type === 'activate_pro_license') {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), LICENSE_SYNC_TIMEOUT_MS);

        try {
          const response = await globalThis.fetch(VERIFY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              key: request.licenseKey,
              version: api.runtime.getManifest().version
            }),
            signal: controller.signal
          });
          const data = await response.json();

          if (!response.ok) {
            return {
              success: false,
              error: data?.error || `License verification failed (${response.status})`,
              code: response.status === 401 || response.status === 403
                ? 'invalid_license'
                : 'activation_failed'
            };
          }

          if (typeof data?.isPro !== 'boolean') {
            return { success: false, error: 'Invalid server response', code: 'activation_failed' };
          }

          if (!data.isPro) {
            return { success: false, error: 'Invalid license key', code: 'invalid_license' };
          }

          statusMessages.push(structuredClone(request));
          if (workerResponse?.success === true) {
            api.storage.sync.data.credentials = {
              ...api.storage.sync.data.credentials,
              isPro: true,
              licenseKey: request.licenseKey,
              subscriptionEmail: data.email,
              expiryDate: data.expiryDate
            };
          }
          return workerResponse;
        } catch (error) {
          return { success: false, error: error.message, code: 'activation_failed' };
        } finally {
          clearTimeout(timeoutId);
        }
      }

      statusMessages.push(structuredClone(request));
      if (workerResponse?.success === true && request.type === 'logout_pro') {
        api.storage.sync.data.credentials = {
          ...api.storage.sync.data.credentials,
          isPro: false,
          licenseKey: null,
          subscriptionEmail: null,
          expiryDate: null
        };
      }
      return workerResponse;
    })();

    if (typeof respond === 'function') operation.then(respond);
    return operation;
  };

  const credentialWrites = [];
  const originalSet = api.storage.sync.set.bind(api.storage.sync);
  api.storage.sync.set = values => {
    if (values.credentials) credentialWrites.push(structuredClone(values.credentials));
    return originalSet(values);
  };

  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const previousConsoleError = console.error;
  let reloadCount = 0;
  const requests = [];
  const timers = [];
  const clearedTimers = [];
  let nextTimerId = 0;
  let currentFetchHandler = fetchHandler || (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      isPro: true,
      email: 'person@example.com',
      expiryDate: '2027-08-01'
    })
  }));
  globalThis.fetch = (...args) => {
    requests.push(args);
    return currentFetchHandler(...args);
  };
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextTimerId;
    timers.push({ id, callback, delay });
    return id;
  };
  globalThis.clearTimeout = id => {
    clearedTimers.push(id);
  };
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
        workerRequests,
        credentialWrites,
        requests,
        timers,
        clearedTimers,
        setFetchHandler: handler => { currentFetchHandler = handler; },
        getReloadCount: () => reloadCount
      });
    }, {
      document,
      window: { location: { reload() { reloadCount += 1; } } }
    });
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
    console.error = previousConsoleError;
  }
}

test('license activation delegates verification and its only credentials mutation to the service worker', async () => {
  await withGoProPage({}, async ({
    api, form, input, message, statusMessages, workerRequests, credentialWrites
  }) => {
    input.value = 'BD-NEW-KEY';
    await form.dispatch('submit');

    assert.equal(statusMessages.length, 1);
    assert.deepEqual(statusMessages[0], {
      type: 'activate_pro_license',
      licenseKey: 'BD-NEW-KEY'
    });
    assert.deepEqual(workerRequests, statusMessages);
    assert.deepEqual(credentialWrites, []);
    assert.equal(api.storage.sync.data.credentials.isPro, true);
    assert.equal(message.textContent, 'proactivated');
  });
});

test('license activation attaches the shared verification timeout and clears it after success', async () => {
  await withGoProPage({}, async ({ form, input, submit, requests, timers, clearedTimers }) => {
    input.value = 'BD-NEW-KEY';

    await form.dispatch('submit');

    assert.equal(requests.length, 1);
    assert.equal(requests[0][1].signal instanceof AbortSignal, true);
    const verificationTimer = timers.find(timer => timer.delay === LICENSE_SYNC_TIMEOUT_MS);
    assert.ok(verificationTimer);
    assert.equal(clearedTimers.includes(verificationTimer.id), true);
    assert.equal(requests[0][1].signal.aborted, false);
    assert.equal(submit.disabled, false);
  });
});

test('a stalled activation request is aborted, reported correctly, and becomes retryable', async () => {
  await withGoProPage({
    fetchHandler: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
      }, { once: true });
    })
  }, async ({ api, form, input, submit, message, statusMessages, requests, timers, clearedTimers }) => {
    input.value = 'BD-STALLED-KEY';
    const pending = form.dispatch('submit');
    const verificationTimer = timers.find(timer => timer.delay === LICENSE_SYNC_TIMEOUT_MS);

    assert.ok(verificationTimer);
    assert.equal(submit.disabled, true);
    verificationTimer.callback();
    await pending;

    assert.equal(requests[0][1].signal.aborted, true);
    assert.equal(clearedTimers.includes(verificationTimer.id), true);
    assert.equal(message.textContent, 'servererror');
    assert.match(message.className, /error/);
    assert.equal(input.value, 'BD-STALLED-KEY');
    assert.equal(submit.disabled, false);
    assert.deepEqual(statusMessages, []);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
  });
});

test('overlapping activation submissions cannot issue duplicate verification requests', async () => {
  let releaseResponse;
  const response = new Promise(resolve => { releaseResponse = resolve; });
  await withGoProPage({ fetchHandler: () => response }, async ({
    api, form, input, submit, statusMessages, requests
  }) => {
    input.value = 'BD-ONLY-ONCE';
    const first = form.dispatch('submit');
    await form.dispatch('submit');

    assert.equal(requests.length, 1);
    assert.equal(submit.disabled, true);
    assert.deepEqual(statusMessages, []);

    releaseResponse({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'once@example.com' })
    });
    await first;

    assert.equal(requests.length, 1);
    assert.equal(statusMessages.length, 1);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-ONLY-ONCE');
    assert.equal(submit.disabled, false);
  });
});

test('an empty activation key never creates a request or verification timeout', async () => {
  await withGoProPage({}, async ({ form, input, message, requests, timers, statusMessages }) => {
    input.value = '   ';

    await form.dispatch('submit');

    assert.equal(message.textContent, 'pleaseenterkey');
    assert.deepEqual(requests, []);
    assert.deepEqual(statusMessages, []);
    assert.equal(timers.some(timer => timer.delay === LICENSE_SYNC_TIMEOUT_MS), false);
  });
});

for (const status of [400, 404, 408, 409, 422, 429, 500, 503]) {
  test(`activation HTTP ${status} reports a temporary server problem, not an invalid key`, async () => {
    await withGoProPage({
      fetchHandler: async () => ({
        ok: false,
        status,
        json: async () => ({ error: `Backend returned ${status}` })
      })
    }, async ({ api, form, input, submit, message, statusMessages }) => {
      input.value = 'BD-MAY-STILL-BE-VALID';

      await form.dispatch('submit');

      assert.equal(message.textContent, 'servererror');
      assert.equal(input.value, 'BD-MAY-STILL-BE-VALID');
      assert.equal(submit.disabled, false);
      assert.deepEqual(statusMessages, []);
      assert.equal(api.storage.sync.data.credentials.isPro, false);
    });
  });
}

for (const status of [401, 403]) {
  test(`activation HTTP ${status} reports an authoritative invalid subscription`, async () => {
    await withGoProPage({
      fetchHandler: async () => ({
        ok: false,
        status,
        json: async () => ({ error: 'Subscription rejected' })
      })
    }, async ({ form, input, submit, message, statusMessages }) => {
      input.value = 'BD-REJECTED';

      await form.dispatch('submit');

      assert.equal(message.textContent, 'subscriptionnotfound');
      assert.equal(submit.disabled, false);
      assert.deepEqual(statusMessages, []);
    });
  });
}

test('an explicitly inactive activation response reports an invalid subscription', async () => {
  await withGoProPage({
    fetchHandler: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isPro: false })
    })
  }, async ({ form, input, message, statusMessages }) => {
    input.value = 'BD-EXPIRED';

    await form.dispatch('submit');

    assert.equal(message.textContent, 'subscriptionnotfound');
    assert.deepEqual(statusMessages, []);
  });
});

test('an offline activation reports a retryable server problem and preserves its key', async () => {
  await withGoProPage({
    fetchHandler: async () => { throw new TypeError('network unavailable'); }
  }, async ({ form, input, submit, message, statusMessages }) => {
    input.value = 'BD-OFFLINE';

    await form.dispatch('submit');

    assert.equal(message.textContent, 'servererror');
    assert.equal(input.value, 'BD-OFFLINE');
    assert.equal(submit.disabled, false);
    assert.deepEqual(statusMessages, []);
  });
});

test('invalid activation JSON cannot masquerade as an invalid subscription', async () => {
  await withGoProPage({
    fetchHandler: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('invalid response'); }
    })
  }, async ({ form, input, message, statusMessages }) => {
    input.value = 'BD-VALID-MAYBE';

    await form.dispatch('submit');

    assert.equal(message.textContent, 'servererror');
    assert.deepEqual(statusMessages, []);
  });
});

test('malformed truthy activation status never grants Pro access', async () => {
  await withGoProPage({
    fetchHandler: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isPro: 'true' })
    })
  }, async ({ api, form, input, message, statusMessages }) => {
    input.value = 'BD-MALFORMED-RESPONSE';

    await form.dispatch('submit');

    assert.equal(message.textContent, 'servererror');
    assert.deepEqual(statusMessages, []);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
  });
});

test('a failed activation can be retried with the same key and later succeeds', async () => {
  await withGoProPage({
    fetchHandler: async () => { throw new TypeError('temporary network failure'); }
  }, async ({ api, form, input, submit, message, requests, statusMessages, setFetchHandler }) => {
    input.value = 'BD-RETRY-KEY';
    await form.dispatch('submit');

    assert.equal(message.textContent, 'servererror');
    assert.equal(submit.disabled, false);
    setFetchHandler(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isPro: true, email: 'retried@example.com' })
    }));

    await form.dispatch('submit');

    assert.equal(requests.length, 2);
    assert.equal(statusMessages.length, 1);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-RETRY-KEY');
    assert.equal(message.textContent, 'proactivated');
  });
});

test('logout delegates its only credentials mutation to the service worker', async () => {
  await withGoProPage({ isPro: true }, async ({
    api, logout, message, statusMessages, credentialWrites
  }) => {
    await logout.dispatch('click');

    assert.equal(statusMessages.length, 1);
    assert.deepEqual(statusMessages[0], { type: 'logout_pro' });
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
    assert.equal(message.textContent, 'servererror');
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
      assert.deepEqual(statusMessages[0], { type: 'logout_pro' });
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
