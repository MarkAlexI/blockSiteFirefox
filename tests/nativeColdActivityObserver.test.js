import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installColdActivityObserver, readColdActivityObserver, removeColdActivityObserver } from '../e2e/cold-message-probes.mjs';

function parentModel() {
  const id = 'native-addon@test', originalAlarm = () => {}, originalActivity = () => {};
  const alarms = { callbacks: new Set([originalAlarm]), alarms: new Map([['minute', { data: { name: 'minute', scheduledTime: 60_000 } }]]) };
  const logger = { listeners: new Map([[id, new Set([originalActivity])]]),
    addListener(key, callback) { this.listeners.get(key).add(callback); },
    removeListener(key, callback) { this.listeners.get(key).delete(callback); } };
  const extension = { persistentBackground: false, apiManager: { apis: new Map() } };
  extension.apiManager.apis.set(extension, new Map([['alarms', alarms]]));
  const window = {};
  const scope = { window, WebExtensionPolicy: { getByID: key => key === id ? { extension } : null },
    ChromeUtils: { importESModule: name => {
      assert.equal(name, 'resource://gre/modules/ExtensionActivityLog.sys.mjs');
      return { ExtensionActivityLog: logger };
    } } };
  const api = vm.runInNewContext(`({ install: ${installColdActivityObserver}, read: ${readColdActivityObserver}, remove: ${removeColdActivityObserver} })`, scope);
  const emit = (payload, sender = { id, url: 'http://cold.bd-e2e.test/producer', frameId: 0 }) =>
    window.__bdColdActivityObserver.activity({ id, viewType: 'background', type: 'api_event', name: 'runtime.onMessage',
      timeStamp: new Date(31_300), data: { args: [payload, sender, () => {}], result: true } });
  return { id, alarms, logger, extension, window, api, emit, originalAlarm, originalActivity };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('parent cold observer model records Firefox payload/sender metadata and native alarms without modifying their API', () => {
  const m = parentModel(); assert.deepEqual(plain(m.api.install(m.id)), { installed: true });
  const payload = { type: 'check_pro_status', __bdColdToken: 'token', __bdColdRequest: 'pro' };
  m.emit(payload); payload.type = 'changed-after-native-event';
  m.window.__bdColdActivityObserver.alarm({ data: { name: 'minute', scheduledTime: 60_000 } });
  const record = plain(m.api.read(m.id));
  assert.deepEqual(record.errors, []); assert.equal(record.events.length, 2);
  assert.equal(record.events[0].at, 31_300); assert.equal(record.events[0].payload.type, 'check_pro_status');
  assert.deepEqual(record.events[0].sender, { id: m.id, url: 'http://cold.bd-e2e.test/producer', frameId: 0 });
  assert.equal(record.events[1].alarm.name, 'minute'); assert.equal(m.alarms.callbacks.size, 2);
  assert.deepEqual(record.nativeAlarms, [{ name: 'minute', scheduledTime: 60_000 }]);
  m.api.remove(m.id);
  assert.deepEqual([...m.alarms.callbacks], [m.originalAlarm]);
  assert.deepEqual([...m.logger.listeners.get(m.id)], [m.originalActivity]);
  assert.equal(m.window.__bdColdActivityObserver, undefined);
});

test('parent cold observer model rejects missing native listeners and duplicate installation', () => {
  for (const remove of [m => m.alarms.callbacks.delete(m.window.__bdColdActivityObserver.alarm),
    m => m.logger.listeners.get(m.id).delete(m.window.__bdColdActivityObserver.activity)]) {
    const m = parentModel(); m.api.install(m.id); remove(m);
    assert.throws(() => m.api.read(m.id), /observer disappeared/); m.api.remove(m.id);
  }
  const m = parentModel(); m.api.install(m.id);
  assert.throws(() => m.api.install(m.id), /already installed/); m.api.remove(m.id);
  m.extension.persistentBackground = true;
  assert.throws(() => m.api.install(m.id), /observer unavailable/);
});

test('parent cold observer model exposes malformed message metadata and lost serialization', () => {
  const m = parentModel(); m.api.install(m.id);
  m.window.__bdColdActivityObserver.activity({ id: m.id, viewType: 'background', type: 'api_event',
    name: 'runtime.onMessage', timeStamp: new Date(31_300), data: { args: [] } });
  const cyclic = {}; cyclic.self = cyclic; m.emit(cyclic);
  assert.equal(m.api.read(m.id).errors.length, 2);
  assert.equal(m.api.read(m.id).events.length, 0); m.api.remove(m.id);
});
