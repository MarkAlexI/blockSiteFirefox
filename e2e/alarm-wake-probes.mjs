// Serialized into Firefox's browser chrome. Keep observers in the parent
// process so they survive event-page unload without an extension view/listener.
export function installAlarmWakeObserver(id) {
  if (window.__bdAlarmWakeObserver) throw new Error('Alarm wake observer already installed');
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  const api = extension?.apiManager.apis?.get(extension)?.get('alarms');
  if (!api || typeof api.callbacks?.add !== 'function' || typeof api.alarms?.values !== 'function') {
    throw new Error('Native cached Firefox alarms observer is unavailable');
  }
  const { ExtensionStorageIDB } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs');
  const { ExtensionDNR } = ChromeUtils.importESModule('resource://gre/modules/ExtensionDNR.sys.mjs');
  const manager = ExtensionDNR.getRuleManager(extension);
  if (typeof manager.setDynamicRules !== 'function') throw new Error('Native Firefox DNR commit observer is unavailable');
  const record = { id, api, manager, events: [], errors: [], sequence: 0 };
  const clone = value => JSON.parse(JSON.stringify(value));
  const observe = (type, data) => {
    try { record.events.push({ sequence: ++record.sequence, at: Date.now(), type, ...clone(data) }); }
    catch (error) { record.errors.push(String(error)); }
  };
  record.alarm = alarm => observe('alarm', { alarm: alarm.data });
  record.storage = changes => {
    try {
      const selected = {};
      for (const key of ['focusSession', 'focusSchedule', 'dailyRuleUsage', 'statistics']) {
        if (!Object.hasOwn(changes, key)) continue;
        selected[key] = Object.fromEntries(Object.entries(changes[key]).map(([name, value]) =>
          [name, typeof value?.deserialize === 'function' ? value.deserialize(globalThis, true) : value]));
      }
      if (Object.keys(selected).length) observe('storage', { changes: selected });
    } catch (error) { record.errors.push(String(error)); }
  };
  // Record every applied ruleset synchronously; return the original result.
  // Do not wrap an extension Promise, delay an API or change alarm dispatch.
  record.dnrDescriptor = Object.getOwnPropertyDescriptor(manager, 'setDynamicRules');
  record.dnrOriginal = manager.setDynamicRules;
  record.dnr = function (...args) {
    const result = record.dnrOriginal.apply(this, args);
    observe('dnr', { rules: this.getDynamicRules() });
    return result;
  };
  manager.setDynamicRules = record.dnr;
  if (manager.setDynamicRules !== record.dnr) throw new Error('Cannot install native DNR commit observer');
  api.callbacks.add(record.alarm);
  ExtensionStorageIDB.addOnChangedListener(id, record.storage);
  window.__bdAlarmWakeObserver = record;
  return { nativeAlarms: [...api.alarms.values()].map(alarm => clone(alarm.data)) };
}

export function readAlarmWakeObserver(id) {
  const record = window.__bdAlarmWakeObserver;
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  const { ExtensionDNR } = ChromeUtils.importESModule('resource://gre/modules/ExtensionDNR.sys.mjs');
  if (record?.id !== id || !extension || ExtensionDNR.getRuleManager(extension) !== record.manager ||
      !record.api.callbacks.has(record.alarm) || record.manager.setDynamicRules !== record.dnr) {
    throw new Error('Native alarm/storage/DNR observer disappeared');
  }
  return JSON.parse(JSON.stringify({ events: record.events, errors: record.errors,
    nativeAlarms: [...record.api.alarms.values()].map(alarm => alarm.data) }));
}

export function resetAlarmWakeHistory(id) {
  const record = window.__bdAlarmWakeObserver;
  if (record?.id !== id) throw new Error('Native alarm wake observer disappeared');
  const before = JSON.parse(JSON.stringify({ events: record.events, errors: record.errors }));
  record.events = []; record.errors = []; record.sequence = 0;
  return before;
}

export function removeAlarmWakeObserver(id) {
  const record = window.__bdAlarmWakeObserver;
  if (record?.id !== id) return;
  const { ExtensionStorageIDB } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs');
  record.api.callbacks.delete(record.alarm);
  ExtensionStorageIDB.removeOnChangedListener(id, record.storage);
  if (record.dnrDescriptor) Object.defineProperty(record.manager, 'setDynamicRules', record.dnrDescriptor);
  else delete record.manager.setDynamicRules;
  delete window.__bdAlarmWakeObserver;
}

export async function readAlarmWakeColdState(id) {
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  if (!extension) throw new Error('Extension disappeared before cold state read');
  const { ExtensionStorageIDB } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs');
  const { ExtensionDNR } = ChromeUtils.importESModule('resource://gre/modules/ExtensionDNR.sys.mjs');
  const { extensionStorageSession } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorage.sys.mjs');
  const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(extension), false);
  const local = await db.get(['rules', 'ruleLists', 'activeRuleListId', 'dailyRuleUsage', 'pendingDailyUsageRemaps',
    'focusSession', 'focusSchedule', 'statistics', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions']);
  const session = Object.fromEntries(Object.entries(extensionStorageSession.get(extension, '__bdIdleSession'))
    .map(([key, value]) => [key, value.deserialize(globalThis, true)]));
  return JSON.parse(JSON.stringify({ ...local, session,
    dnr: ExtensionDNR.getRuleManager(extension).getDynamicRules() }));
}
