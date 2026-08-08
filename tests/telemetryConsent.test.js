import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTelemetryConsent,
  setTelemetryConsent,
  requestTelemetryConsentFromUserAction,
  TELEMETRY_CONSENT_KEY,
  TELEMETRY_DATA_COLLECTION_PERMISSION
} from '../telemetry/telemetryConsent.js';

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const result = {};
      for (const key of keys) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(values) { Object.assign(data, structuredClone(values)); }
  };
}

function createPermissions({ supported = true, granted = false } = {}) {
  let enabled = granted;
  const requests = [];
  const removals = [];
  return {
    requests,
    removals,
    async getAll() {
      if (!supported) return { permissions: [], origins: [] };
      return {
        permissions: [],
        origins: [],
        data_collection: enabled ? [TELEMETRY_DATA_COLLECTION_PERMISSION] : []
      };
    },
    async request(value) {
      requests.push(structuredClone(value));
      enabled = true;
      return true;
    },
    async remove(value) {
      removals.push(structuredClone(value));
      enabled = false;
      return true;
    }
  };
}

test('older Firefox versions use local opt-in and remain disabled by default', async () => {
  const storage = createStorage();
  const permissions = createPermissions({ supported: false });

  assert.deepEqual(await getTelemetryConsent(storage, permissions), {
    version: 1,
    enabled: false,
    decidedAt: null,
    source: 'local'
  });
  assert.equal(storage.data[TELEMETRY_CONSENT_KEY], undefined);

  const consent = await setTelemetryConsent(storage, true, () => 1234, permissions);
  assert.deepEqual(consent, {
    version: 1,
    enabled: true,
    decidedAt: 1234,
    source: 'local'
  });
});

test('modern Firefox uses built-in technicalAndInteraction permission as source of truth', async () => {
  const storage = createStorage({
    [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: 10 }
  });
  const permissions = createPermissions({ supported: true, granted: false });

  const disabled = await getTelemetryConsent(storage, permissions);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.source, 'firefox_builtin');

  await requestTelemetryConsentFromUserAction(permissions, true);
  const enabled = await setTelemetryConsent(storage, true, () => 20, permissions);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.source, 'firefox_builtin');
  assert.deepEqual(permissions.requests, [{
    data_collection: [TELEMETRY_DATA_COLLECTION_PERMISSION]
  }]);

  await requestTelemetryConsentFromUserAction(permissions, false);
  const removed = await setTelemetryConsent(storage, false, () => 30, permissions);
  assert.equal(removed.enabled, false);
  assert.deepEqual(permissions.removals, [{
    data_collection: [TELEMETRY_DATA_COLLECTION_PERMISSION]
  }]);
});

test('modern Firefox consent lookup fails closed if permissions cannot be queried', async () => {
  const storage = createStorage({
    [TELEMETRY_CONSENT_KEY]: { version: 1, enabled: true, decidedAt: 10 }
  });
  const permissions = {
    async getAll() { throw new Error('temporary failure'); }
  };

  const consent = await getTelemetryConsent(storage, permissions);
  assert.equal(consent.enabled, false);
  assert.equal(consent.source, 'firefox_builtin');
});
