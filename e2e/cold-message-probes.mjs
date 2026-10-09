// Serialized into browser chrome. Native parent observers survive event-page
// unload without an extension view, API listener or debugger on the background.
export function installColdActivityObserver(id) {
  if (window.__bdColdActivityObserver) throw new Error('Cold activity observer already installed');
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  const alarms = extension?.apiManager.apis?.get(extension)?.get('alarms');
  const { ExtensionActivityLog } = ChromeUtils.importESModule('resource://gre/modules/ExtensionActivityLog.sys.mjs');
  if (!extension || extension.persistentBackground || typeof alarms?.callbacks?.add !== 'function' ||
      typeof ExtensionActivityLog.addListener !== 'function') throw new Error('Native cold activity observer unavailable');
  const record = { id, extension, alarms, logger: ExtensionActivityLog, sequence: 0, events: [], errors: [] };
  const observe = (type, at, data) => {
    try {
      if (!Number.isFinite(at)) throw new Error('Native cold activity omitted its timestamp');
      if (record.events.length >= 2000) throw new Error('Native cold activity history overflow');
      record.events.push({ sequence: ++record.sequence, at, receivedAt: Date.now(), type,
        ...JSON.parse(JSON.stringify(data)) });
    } catch (error) { record.errors.push(String(error)); }
  };
  record.activity = activity => {
    if (activity.type !== 'api_event' || activity.name !== 'runtime.onMessage' || activity.viewType !== 'background') return;
    const args = activity.data?.args;
    if (!Array.isArray(args) || args.length < 2) {
      record.errors.push('Native runtime.onMessage omitted payload/sender'); return;
    }
    // Firefox supplies payload and MessageSender here, unlike Chromium's
    // sender-metadata-only ActivityLog. Do not serialize sendResponse/result.
    observe('message', Number(activity.timeStamp), { extensionId: activity.id, viewType: activity.viewType,
      payload: args[0], sender: args[1] });
  };
  record.alarm = alarm => observe('alarm', Date.now(), { alarm: alarm.data });
  try {
    alarms.callbacks.add(record.alarm);
    ExtensionActivityLog.addListener(id, record.activity);
    window.__bdColdActivityObserver = record;
  } catch (error) {
    alarms.callbacks.delete(record.alarm);
    ExtensionActivityLog.removeListener(id, record.activity);
    throw error;
  }
  return { installed: true };
}

export function readColdActivityObserver(id) {
  const record = window.__bdColdActivityObserver;
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  if (record?.id !== id || extension !== record.extension || !record.alarms.callbacks.has(record.alarm) ||
      !record.logger.listeners.get(id)?.has(record.activity)) throw new Error('Native cold activity observer disappeared');
  return JSON.parse(JSON.stringify({ sequence: record.sequence, events: record.events, errors: record.errors,
    nativeAlarms: [...record.alarms.alarms.values()].map(alarm => alarm.data) }));
}

export function removeColdActivityObserver(id) {
  const record = window.__bdColdActivityObserver;
  if (record?.id !== id) return;
  record.alarms.callbacks.delete(record.alarm);
  record.logger.removeListener(id, record.activity);
  delete window.__bdColdActivityObserver;
}
