// These functions run in Firefox's browser chrome via Marionette. They never
// attach a toolbox, call extension APIs or invoke wakeup/terminateBackground.
export function installIdleObserver(id) {
  if (window.__bdIdleObserver) throw new Error('Idle observer already installed');
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  if (!extension || extension.persistentBackground) throw new Error('Expected a Firefox event page');
  const record = window.__bdIdleObserver = { id, events: [], installedAt: Date.now() };
  record.observer = subject => {
    const status = subject.wrappedJSObject || subject;
    if (status.addonId === id) record.events.push({ at: Date.now(), running: status.isRunning });
  };
  Services.obs.addObserver(record.observer, 'extension:background-script-status');
  return { idleTimeout: Services.prefs.getIntPref('extensions.background.idle.timeout', 30_000),
    idleTimeoutOverridden: Services.prefs.prefHasUserValue('extensions.background.idle.timeout') };
}

export function readIdleObserver(id) {
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  if (!extension || window.__bdIdleObserver?.id !== id) throw new Error('Extension/idle observer disappeared');
  return { at: Date.now(), processId: Services.appinfo.processID,
    profile: Services.dirsvc.get('ProfD', Components.interfaces.nsIFile).path, state: extension.backgroundState,
    views: [...extension.views].map(view => ({ type: view.viewType, unloaded: Boolean(view.unloaded) })),
    tabs: [...gBrowser.browsers].map(browser => browser.currentURI.spec),
    events: window.__bdIdleObserver.events.map(event => ({ ...event })) };
}

export function removeIdleObserver(id) {
  const record = window.__bdIdleObserver;
  if (record?.id !== id) return;
  Services.obs.removeObserver(record.observer, 'extension:background-script-status');
  delete window.__bdIdleObserver;
}

// Read the same native backends used by storage.local/session and DNR. Do not
// open Popup/Options or send a corrective runtime intent before this snapshot.
export async function readColdState(id) {
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  if (!extension) throw new Error('Extension disappeared before cold state read');
  const { ExtensionStorageIDB } = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorageIDB.sys.mjs');
  const { ExtensionDNR } = ChromeUtils.importESModule('resource://gre/modules/ExtensionDNR.sys.mjs');
  const session = ChromeUtils.importESModule('resource://gre/modules/ExtensionStorage.sys.mjs');
  const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(extension), false);
  const local = await db.get(['rules', 'ruleLists', 'activeRuleListId', 'dailyRuleUsage', 'pendingDailyUsageRemaps',
    'focusSession', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions']);
  const sessionValues = Object.fromEntries(Object.entries(session.extensionStorageSession.get(extension, '__bdIdleSession'))
    .map(([key, value]) => [key, value.deserialize(globalThis, true)]));
  return JSON.parse(JSON.stringify({ ...local,
    session: sessionValues,
    dnr: ExtensionDNR.getRuleManager(extension).getDynamicRules() }));
}
