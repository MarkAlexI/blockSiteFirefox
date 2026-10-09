// Serialized into the installed extension's real background window. Native
// storage.set runs first; only one journal-write Promise delivery is delayed.
export function installLiveDayProbe(view) {
  if (view.__bdLiveDay) throw new Error('Live-day probe already installed');
  const api = view.browser;
  const state = view.__bdLiveDay = { token: view.crypto.randomUUID(), events: [], gate: null };
  const record = (type, data) => state.events.push({ at: view.Date.now(), type, ...structuredClone(data) });
  const set = api.storage.local.set;
  api.storage.local.set = (...args) => {
    const values = args[0];
    const journal = values?.rules && values?.ruleLists && values?.pendingDailyUsageRemaps?.length > 0;
    const held = journal && state.gate && !state.gate.entered;
    if (held && typeof args.at(-1) === 'function') throw new Error('Expected the production Promise journal writer');
    if (values?.dailyRuleUsage) record('usage-write-called', { values: values.dailyRuleUsage });
    const native = set.apply(api.storage.local, args);
    if (!held) return native;
    const stack = new view.Error().stack;
    return native.then(async result => {
      state.gate.entered = true; state.gate.enteredAt = view.Date.now();
      state.gate.values = structuredClone(values); state.gate.stack = stack;
      record('journal-committed', { values });
      await new view.Promise(resolve => { state.release = () => {
        record('journal-delivery-released', {}); state.release = null; resolve();
      }; });
      return result;
    });
  };
  const changed = (changes, area) => {
    if (area !== 'local') return;
    if (changes.dailyRuleUsage) record('usage-storage-changed', { values: changes.dailyRuleUsage.newValue });
    if (changes.pendingDailyUsageRemaps) record('journal-storage-changed', { values: changes.pendingDailyUsageRemaps.newValue });
  };
  api.storage.onChanged.addListener(changed);
  state.restore = () => {
    state.release?.(); api.storage.local.set = set;
    api.storage.onChanged.removeListener(changed); delete view.__bdLiveDay;
  };
}

// Marionette browser-chrome scope. This is Gecko's native per-context Date/Intl
// timezone emulation field, also used by BiDi, targeting the hidden event page.
export function setBackgroundTimezone({ id, timezone }) {
  const extension = WebExtensionPolicy.getByID(id)?.extension;
  const view = [...extension.views].find(item => item.viewType === 'background');
  if (!view?.browsingContext) throw new Error('Live event-page BrowsingContext is missing');
  const context = view.browsingContext;
  const before = context.timezoneOverride;
  context.timezoneOverride = timezone;
  return { before, after: context.timezoneOverride, context: String(context.id),
    processId: Services.appinfo.processID };
}
