// This function is serialized into the real background realm by the harness.
// Native APIs run first. Only delivery of one controller read/write is held;
// clocks, storage values, alarms, DNR results and production code are unchanged.
export function installScheduledExpiryProbe(view, { namespace }) {
  if (view.__bdScheduledExpiry) throw new Error('Scheduled expiry probe already installed');
  const api = view[namespace];
  const state = view.__bdScheduledExpiry = { events: [], gate: null, sequence: 0 };
  const originals = [];
  const record = (type, data) => state.events.push({ sequence: ++state.sequence,
    now: view.Date.now(), type, ...structuredClone(data) });
  const wrap = (object, method, replacement) => {
    const original = object[method];
    originals.push(() => { object[method] = original; });
    object[method] = replacement(original.bind(object));
    if (object[method] === original) throw new Error(`Cannot observe native ${method}`);
  };
  const hold = async (phase, stack, values) => {
    const gate = state.gate;
    if (!gate || gate.phase !== phase || gate.enteredAt || !stack.includes('focusScheduleController.js')) return;
    if (phase === 'after-claim' && !values.focusSchedule?.handledKeys.includes(gate.key)) return;
    gate.enteredAt = view.Date.now();
    gate.stack = stack;
    gate.nativeResult = structuredClone(values);
    record('gate-entered', { phase, key: gate.key });
    await new view.Promise(resolve => { state.release = () => {
      gate.releasedAt = view.Date.now();
      record('gate-released', { phase, key: gate.key });
      state.release = null;
      resolve();
    }; });
  };
  // The controller's getSession is the single-key, Promise storage read.
  // Other callers (including probes) keep running and retain native results.
  wrap(api.storage.local, 'get', original => (...args) => {
    const keys = args[0];
    if (!Array.isArray(keys) || keys.length !== 1 || keys[0] !== 'focusSession' ||
        typeof args.at(-1) === 'function') return original(...args);
    const stack = new view.Error().stack;
    return (async () => {
      const raw = await original(...args);
      await hold('before-claim', stack, raw);
      return raw;
    })();
  });
  wrap(api.storage.local, 'set', original => (...args) => {
    const values = args[0];
    if (!values || (!('focusSession' in values) && !('focusSchedule' in values))) return original(...args);
    const stack = new view.Error().stack;
    record('storage-write-called', { values });
    const finished = async result => {
      record('storage-write-committed', { values });
      await hold('after-claim', stack, values);
      return result;
    };
    if (typeof args.at(-1) === 'function') {
      const callback = args.at(-1);
      return original(...args.slice(0, -1), (...reply) => {
        if (!api.runtime.lastError) record('storage-write-committed', { values });
        callback(...reply);
      });
    }
    return original(...args).then(finished);
  });
  const getDnr = api.declarativeNetRequest.getDynamicRules.bind(api.declarativeNetRequest);
  wrap(api.declarativeNetRequest, 'updateDynamicRules', original => (...args) => {
    record('dnr-update-called', { update: args[0] });
    if (typeof args.at(-1) === 'function') {
      throw new Error('Expiry observer expects the production Promise DNR caller');
    }
    return original(...args).then(async result => {
      record('dnr-update-committed', { rules: await getDnr() });
      return result;
    });
  });
  const changed = (changes, area) => {
    if (area !== 'local') return;
    const tracked = {};
    for (const key of ['focusSchedule', 'focusSession']) if (changes[key]) tracked[key] = changes[key];
    if (Object.keys(tracked).length) record('storage-changed', { changes: tracked });
  };
  const alarm = value => record('native-alarm', { alarm: value });
  api.storage.onChanged.addListener(changed);
  api.alarms.onAlarm.addListener(alarm);
  state.restore = () => {
    state.release?.();
    api.storage.onChanged.removeListener(changed);
    api.alarms.onAlarm.removeListener(alarm);
    for (const restore of originals.reverse()) restore();
    delete view.__bdScheduledExpiry;
  };
}

export function readScheduledExpiryProbe(view) {
  const { events, gate } = view.__bdScheduledExpiry;
  return { events, gate, now: view.Date.now() };
}

// Compile the wrapper in Node, before serialization through Playwright/BiDi.
// No eval/Function is executed in an extension page or background realm.
export function inBackground(e, fn, input) {
  const source = fn.toString();
  if (e.worker) return e.worker.evaluate(new Function('input',
    `return (${source})(globalThis, input);`), input);
  return e.probe.evaluate(new Function('input', `return (async () => {
    const view = await browser.runtime.getBackgroundPage();
    return (${source})(view, input);
  })();`), input);
}
