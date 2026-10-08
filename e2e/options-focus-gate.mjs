// Gate only delivery of the former 100ms autofocus callback. Its timer remains
// native; WebDriver command latency cannot consume the interleaving window.
export function installOptionsFocusGate(view = null) {
  view ||= globalThis;
  if (view.__bdOptionsFocusGate) throw new Error('Options focus gate already installed');
  const originalTimeout = view.setTimeout;
  const nativeTimeout = originalTimeout.bind(view);
  const state = view.__bdOptionsFocusGate = { phase: null };
  view.setTimeout = (callback, delay, ...args) => {
    const phase = state.phase;
    const isFocus = typeof callback === 'function' && /\.focus\s*(?:\?\.)?\s*\(/.test(callback.toString());
    if (!phase || Number(delay) !== 100 || !isFocus) return nativeTimeout(callback, delay, ...args);
    const entry = { delivered: false, executed: false };
    entry.ready = new view.Promise(resolve => { entry.resolve = resolve; });
    phase.timers.push(entry);
    return nativeTimeout(() => {
      entry.delivered = true;
      entry.run = () => { entry.executed = true; callback.apply(view, args); };
      entry.resolve();
      if (phase.released) entry.run();
    }, delay);
  };
  state.begin = () => {
    if (state.phase && !state.phase.released) throw new Error('Previous focus gate not released');
    const phase = state.phase = { timers: [], released: false, deadlinePassed: false };
    phase.deadline = new view.Promise(resolve => nativeTimeout(() => {
      phase.deadlinePassed = true; resolve();
    }, 100));
  };
  state.releaseAfterDeadline = async () => {
    const phase = state.phase;
    await phase.deadline;
    await view.Promise.all(phase.timers.map(entry => entry.ready));
    phase.released = true;
    for (const entry of phase.timers) if (entry.delivered) entry.run();
    return { deadlinePassed: phase.deadlinePassed, registered: phase.timers.length,
      delivered: phase.timers.filter(entry => entry.delivered).length,
      executed: phase.timers.filter(entry => entry.executed).length };
  };
  state.restore = () => { view.setTimeout = originalTimeout; };
  return true;
}
