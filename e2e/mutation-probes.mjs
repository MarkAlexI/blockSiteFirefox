// Serialized into the genuine background realm. Calls retain their native
// results. Storage gates hold only delivery AFTER the real write; the DNR gate
// holds invocation, then delivery, so both sides of the real commit are tested.
export function installMutationProbe(view, { phase, token, oldKey = '21:list-1', expectedHost }) {
  if (!['journal', 'remapped', 'dnr'].includes(phase)) throw new Error('Unknown mutation probe phase');
  if (view.__bdMutationProbe) throw new Error('Mutation probe already installed');
  const api = view.browser || view.chrome;
  const state = view.__bdMutationProbe = { phase, token, events: [], entered: null, overflow: false };
  const originals = [];
  const record = (type, values) => {
    if (state.events.length >= 1000) { state.overflow = true; return; }
    state.events.push({ type, at: view.Date.now(), ...structuredClone(values) });
  };
  const hold = label => state.restored ? view.Promise.resolve() : new view.Promise(resolve => {
    state.release = () => { state.release = null; record('released', { label }); resolve(); };
  });
  const wrap = (object, name, factory) => {
    const native = object[name];
    originals.push(() => { object[name] = native; });
    object[name] = factory(native.bind(object));
    if (object[name] === native) throw new Error(`Cannot observe native ${name}`);
  };
  const getDnr = api.declarativeNetRequest.getDynamicRules.bind(api.declarativeNetRequest);
  const getLocal = api.storage.local.get.bind(api.storage.local);
  wrap(api.storage.local, 'set', native => (...args) => {
    if (phase === 'dnr' || typeof args.at(-1) === 'function') return native(...args);
    const values = args[0];
    const matches = phase === 'journal'
      ? Array.isArray(values?.rules) && values.pendingDailyUsageRemaps?.some(item => `${item.oldRuleId}:${item.oldListId}` === oldKey)
      : Array.isArray(values?.pendingDailyUsageRemaps) && values.pendingDailyUsageRemaps.length === 0 &&
        values.dailyRuleUsage && !Object.hasOwn(values.dailyRuleUsage.usageSeconds, oldKey);
    return native(...args).then(async result => {
      if (matches && !state.entered) {
        const local = await getLocal(['rules', 'dailyRuleUsage', 'pendingDailyUsageRemaps', '__bdInterruptionMarker']);
        if (expectedHost && !local.rules?.some(rule => rule.blockURL === expectedHost)) return result;
        state.entered = { at: view.Date.now(), values: structuredClone(values), local };
        record('storage-committed', { values });
        state.entered.dnr = await getDnr();
        state.ready = true;
        await hold('storage-result');
      }
      return result;
    });
  });
  wrap(api.declarativeNetRequest, 'updateDynamicRules', native => (...args) => {
    if (typeof args.at(-1) === 'function') throw new Error('Mutation probe expects the production Promise DNR API');
    const run = async () => {
      const update = structuredClone(args[0]);
      const matches = !expectedHost || update.addRules?.some(rule => {
        try { return new URL(rule.action.redirect.url).searchParams.get('url') === expectedHost; }
        catch { return false; }
      });
      const first = phase === 'dnr' && !state.entered && matches;
      record('dnr-called', { update });
      if (first) {
        state.entered = { at: view.Date.now(), update, before: await getDnr() };
        state.ready = true;
        await hold('before-dnr');
      }
      const result = await native(...args);
      const rules = await getDnr();
      record('dnr-committed', { update, rules });
      if (first) {
        state.committed = { at: view.Date.now(), rules };
        await hold('after-dnr');
      }
      return result;
    };
    return run();
  });
  state.restore = () => {
    state.restored = true;
    state.release?.();
    for (const restore of originals.reverse()) restore();
    delete view.__bdMutationProbe;
  };
}

export function readMutationProbe(view) {
  const value = view.__bdMutationProbe;
  if (!value) throw new Error('Mutation probe is not installed');
  return { phase: value.phase, token: value.token, events: value.events,
    entered: value.entered, ready: value.ready === true, committed: value.committed ?? null, overflow: value.overflow };
}

export function releaseMutationProbe(view) {
  const probe = view.__bdMutationProbe;
  if (typeof probe?.release !== 'function') throw new Error('Mutation probe has no held native call');
  probe.release();
}

export function restoreMutationProbe(view) { view.__bdMutationProbe?.restore(); }

// Launch one genuine production intent without holding the automation command
// open across process termination or the controlled DNR wait. Rejections are
// consumed and retained rather than becoming unhandled page errors.
export function beginMutation(message) {
  if (globalThis.__bdMutationReply?.pending) throw new Error('Previous mutation is still pending');
  globalThis.__bdMutationReply = { pending: true };
  const api = globalThis.browser || chrome;
  const request = globalThis.browser ? api.runtime.sendMessage(message) : new Promise((resolve, reject) =>
    api.runtime.sendMessage(message, result => {
      if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message)); else resolve(result);
    }));
  request.then(value => { globalThis.__bdMutationReply = { pending: false, value }; },
    error => { globalThis.__bdMutationReply = { pending: false, error: String(error) }; });
  return true;
}
