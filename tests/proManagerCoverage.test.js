import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

async function withProManager({ sync = {}, document = null } = {}, callback) {
  const api = createExtensionApi({ sync });
  await withExtensionEnvironment(api, async () => {
    const { ProManager } = await import('../pro/proManager.js');
    await callback({ api, ProManager });
  }, { document });
}

async function suppressConsoleError(callback) {
  const previous = console.error;
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.error = previous;
  }
}

test('missing Pro credentials initialize as Free rather than granting access', async () => {
  await withProManager({}, async ({ api, ProManager }) => {
    assert.equal(await ProManager.isPro(), false);
    assert.equal(api.storage.sync.data.credentials.isPro, false);
    assert.equal(api.storage.sync.data.credentials.licenseKey, null);
  });
});

test('Pro access accepts only the explicit boolean true', async () => {
  for (const [value, expected] of [[true, true], [false, false], ['true', false], [1, false]]) {
    await withProManager({ sync: { credentials: { isPro: value } } }, async ({ ProManager }) => {
      assert.equal(await ProManager.isPro(), expected);
    });
  }
});

test('credential initialization records an installation date and applies all defaults', async () => {
  await withProManager({}, async ({ api, ProManager }) => {
    const credentials = await ProManager.getCredentials();
    assert.equal(credentials.isPro, false);
    assert.equal(Number.isNaN(Date.parse(credentials.installationDate)), false);
    assert.equal(typeof credentials.isLegacyUser, 'boolean');
    assert.deepEqual(api.storage.sync.data.credentials, credentials);
  });
});

test('partial stored credentials retain their existing data and receive missing defaults', async () => {
  await withProManager({ sync: { credentials: {
    isPro: true,
    licenseKey: 'BD-PRO-123',
    installationDate: '2025-12-31T00:00:00.000Z'
  } } }, async ({ ProManager }) => {
    const credentials = await ProManager.getCredentials();
    assert.equal(credentials.isPro, true);
    assert.equal(credentials.licenseKey, 'BD-PRO-123');
    assert.equal(credentials.subscriptionEmail, null);
    assert.equal(credentials.isLegacyUser, false);
  });
});

test('legacy status uses the documented restriction boundary', async () => {
  for (const [installationDate, expected] of [
    ['2025-12-31T23:59:59.999Z', true],
    ['2026-01-01T00:00:00.000Z', false],
    [null, true]
  ]) {
    await withProManager({ sync: { credentials: { installationDate } } }, async ({ ProManager }) => {
      assert.equal(await ProManager.isLegacyUser(), expected);
    });
  }
});

test('upgrading preserves existing subscription fields and sends a status notification', async () => {
  await withProManager({ sync: { credentials: {
    isPro: false,
    installationDate: '2026-08-01T00:00:00.000Z',
    isLegacyUser: true,
    subscriptionDate: '2026-08-01'
  } } }, async ({ api, ProManager }) => {
    const updated = await ProManager.updateProStatus(true, {
      licenseKey: 'BD-PRO-123',
      subscriptionEmail: 'person@example.com',
      expiryDate: '2027-08-01'
    });

    assert.equal(updated.isPro, true);
    assert.equal(updated.licenseKey, 'BD-PRO-123');
    assert.equal(updated.subscriptionEmail, 'person@example.com');
    assert.equal(updated.subscriptionDate, '2026-08-01');
    assert.equal(updated.installationDate, '2026-08-01T00:00:00.000Z');
    assert.equal(updated.isLegacyUser, true);
    assert.deepEqual(api.messages.at(-1), { type: 'pro_status_changed', isPro: true });
  });
});

test('downgrading to Free clears paid credentials but preserves installation and legacy state', async () => {
  await withProManager({ sync: { credentials: {
    isPro: true,
    licenseKey: 'BD-PRO-SECRET',
    subscriptionEmail: 'person@example.com',
    subscriptionDate: '2026-07-01',
    expiryDate: '2027-07-01',
    installationDate: '2025-12-01T00:00:00.000Z',
    isLegacyUser: true
  } } }, async ({ api, ProManager }) => {
    const updated = await ProManager.updateProStatus(false);
    assert.deepEqual(updated, {
      isPro: false,
      subscriptionEmail: null,
      subscriptionDate: null,
      expiryDate: null,
      licenseKey: null,
      isLegacyUser: true,
      installationDate: '2025-12-01T00:00:00.000Z'
    });
    assert.deepEqual(api.messages.at(-1), { type: 'pro_status_changed', isPro: false });
  });
});

test('Pro feature visibility switches every protected element without requiring browser windows', async () => {
  const document = new FakeDocument();
  const first = document.addElement('first');
  const second = document.addElement('second');
  first.className = 'pro-feature hidden';
  second.className = 'pro-feature hidden';

  await withProManager({ sync: { credentials: { isPro: true } }, document }, async ({ ProManager }) => {
    ProManager.updateProFeaturesVisibility(true);
    assert.equal(first.classList.contains('hidden'), false);
    assert.equal(second.classList.contains('hidden'), false);

    ProManager.updateProFeaturesVisibility(false);
    assert.equal(first.classList.contains('hidden'), true);
    assert.equal(second.classList.contains('hidden'), true);

    assert.equal(await ProManager.initializeProFeatures(), true);
    assert.equal(first.classList.contains('hidden'), false);
  });
});

test('Pro updates work in a service worker without a DOM or windows API', async () => {
  await withProManager({ sync: { credentials: { installationDate: '2026-08-01' } } }, async ({ api, ProManager }) => {
    assert.equal(ProManager.hasDOM, false);
    assert.equal(api.windows, undefined);
    const credentials = await ProManager.setProStatusFromWorker(true, { licenseKey: 'BD-PRO-456' });
    assert.equal(credentials.isPro, true);
    assert.equal(credentials.licenseKey, 'BD-PRO-456');
  });
});

test('storage failures fail closed for Pro checks and return default credentials', async () => {
  await withProManager({}, async ({ api, ProManager }) => {
    api.storage.sync.getError = new Error('sync storage unavailable');
    await suppressConsoleError(async () => {
      assert.equal(await ProManager.isPro(), false);
      assert.deepEqual(await ProManager.getCredentials(), ProManager.defaultCredentials);
    });
  });
});

test('credential write failures propagate to worker updates instead of reporting success', async () => {
  await withProManager({ sync: { credentials: { isPro: false } } }, async ({ api, ProManager }) => {
    api.storage.sync.setError = new Error('sync storage read-only');
    await suppressConsoleError(async () => {
      await assert.rejects(ProManager.updateProStatus(true), /read-only/);
      await assert.rejects(ProManager.setProStatusFromWorker(true), /read-only/);
    });
  });
});

test('failed status notifications do not revert a successful credential update', async () => {
  await withProManager({ sync: { credentials: { isPro: false } } }, async ({ api, ProManager }) => {
    api.runtime.sendMessage = () => Promise.reject(new Error('background unavailable'));
    const result = await ProManager.updateProStatus(true, { licenseKey: 'BD-PRO-789' });
    assert.equal(result.isPro, true);
    assert.equal(api.storage.sync.data.credentials.licenseKey, 'BD-PRO-789');
  });
});
