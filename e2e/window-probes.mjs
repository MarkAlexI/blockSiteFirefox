import assert from 'node:assert/strict';

// Passive listeners in an extension reader. Native APIs and delivery are untouched.
export function installWindowObserver() {
  const api = globalThis.browser || chrome;
  const view = { history: [], listeners: [], overflow: false };
  view.add = (kind, value) => {
    if (view.history.length >= 5000) { view.overflow = true; return; }
    view.history.push({ kind, at: Date.now(), ...value });
  };
  const listen = (event, listener) => { event.addListener(listener); view.listeners.push([event, listener]); };
  const tab = value => ({ id: value.id, windowId: value.windowId, active: value.active,
    url: value.url, status: value.status });
  listen(api.tabs.onRemoved, (tabId, value) => view.add('removed', { tabId, ...value }));
  listen(api.tabs.onCreated, value => view.add('created', { tab: tab(value) }));
  listen(api.tabs.onActivated, value => view.add('activated', value));
  listen(api.tabs.onDetached, (tabId, value) => view.add('detached', { tabId, ...value }));
  listen(api.tabs.onAttached, (tabId, value) => view.add('attached', { tabId, ...value }));
  listen(api.tabs.onUpdated, (tabId, change, value) => {
    if (change.url || change.status) view.add('updated', { tabId, change, tab: tab(value) });
  });
  listen(api.windows.onCreated, value => view.add('window-created', { windowId: value.id }));
  listen(api.windows.onFocusChanged, windowId => view.add('window-focus', { windowId }));
  listen(api.storage.onChanged, (change, area) => {
    if (area === 'local' && change.dailyRuleUsage) {
      view.add('usage', { value: change.dailyRuleUsage.newValue });
    }
  });
  globalThis.__bdWindowObserver = view;
  return true;
}

export function readWindowObserver() {
  const view = globalThis.__bdWindowObserver;
  return { history: view.history, overflow: view.overflow };
}

export function removeWindowObserver() {
  const view = globalThis.__bdWindowObserver;
  if (view) for (const [event, listener] of view.listeners) event.removeListener(listener);
  delete globalThis.__bdWindowObserver;
  return true;
}

export async function windowOperation(input) {
  const api = globalThis.browser || chrome;
  switch (input.op) {
    case 'current': return api.windows.getCurrent();
    case 'create-tab': return api.tabs.create({ windowId: input.windowId, url: input.url, active: input.active });
    case 'create-window': return api.windows.create({ tabId: input.tabId, type: 'normal', focused: false });
    case 'focus':
      await api.tabs.update(input.tabId, { active: true });
      return api.windows.update(input.windowId, { focused: true });
    case 'activate': return api.tabs.update(input.tabId, { active: true });
    case 'move': return api.tabs.move(input.tabId, { windowId: input.windowId, index: -1 });
    case 'navigate': return api.tabs.update(input.tabId, { url: input.url });
    default: throw new Error('Unknown window operation: ' + input.op);
  }
}

export async function nativeWindowSnapshot(input) {
  const api = globalThis.browser || chrome;
  const state = await api.storage.local.get(['dailyRuleUsage', 'pendingDailyUsageRemaps']);
  const windows = (await api.windows.getAll()).map(value => ({ id: value.id, focused: value.focused, type: value.type }));
  const liveTabs = await api.tabs.query({});
  const tabs = await Promise.all(input.ids.map(async id => {
    const value = liveTabs.find(tab => tab.id === id);
    if (!value) return { id, removed: true };
    let document = null, error = null;
    try {
      const result = await api.scripting.executeScript({ target: { tabId: id }, func: () => ({
        url: location.href, title: document.querySelector('h1')?.textContent || null,
        visible: document.visibilityState, hidden: document.hidden, focused: document.hasFocus(),
        timeOrigin: performance.timeOrigin
      }) });
      document = result.find(item => item.frameId === 0)?.result || null;
    } catch (failure) { error = failure.message; }
    return { id, windowId: value.windowId, active: value.active, status: value.status,
      url: value.url, document, error };
  }));
  return { at: Date.now(), ...state, windows, tabs,
    dnr: (await api.declarativeNetRequest.getDynamicRules()).map(value => value.id).sort((a, b) => a - b) };
}

// Stable focus phases only. Focus transitions may include WINDOW_ID_NONE and
// per-window activation events in a browser-dependent order.
export function assertWindowPhase({ before, after, events, owner, inactive, windowId }) {
  assert.deepEqual(before.dailyRuleUsage.lastSample.assignmentKeys, [owner], 'foreground owner at phase entry');
  const samples = events.filter(event => event.kind === 'usage');
  assert.ok(samples.length > 0, 'native page events produced observable durable samples');
  for (const event of [...samples, { value: after.dailyRuleUsage }]) {
    assert.deepEqual(event.value.lastSample?.assignmentKeys, [owner], 'background event must not steal the foreground segment');
    assert.equal(event.value.usageSeconds[inactive], before.dailyRuleUsage.usageSeconds[inactive], 'unfocused window budget is unchanged in every observed write');
  }
  for (const event of events.filter(value => value.kind === 'window-focus')) {
    assert.equal(event.windowId, windowId, 'focus remained in the measured window');
  }
  const gain = after.dailyRuleUsage.usageSeconds[owner] - before.dailyRuleUsage.usageSeconds[owner];
  const elapsed = after.dailyRuleUsage.lastSample.timestamp - before.dailyRuleUsage.lastSample.timestamp;
  assert.ok(gain >= 1, 'positive control: genuine foreground time was charged');
  assert.ok(gain <= Math.floor(elapsed / 1000), 'no duplicate charge within a stable foreground phase');
  assert.deepEqual(after.pendingDailyUsageRemaps, []);
  return { gain, elapsed, writes: samples.length };
}

export function assertWindowAccounting(history, initialUsage) {
  let previous = initialUsage;
  let firstTimestamp = null;
  let firstUsage = null;
  for (const event of history.filter(value => value.kind === 'usage')) {
    const state = event.value;
    for (const key of Object.keys(initialUsage)) {
      assert.ok(state.usageSeconds[key] >= previous[key], 'window changes never erase spent budget');
    }
    if (firstTimestamp === null && state.lastSample) {
      firstTimestamp = state.lastSample.timestamp;
      firstUsage = { ...state.usageSeconds };
    } else if (state.lastSample && firstTimestamp !== null) {
      const total = Object.keys(initialUsage).reduce((sum, key) => sum + state.usageSeconds[key] - firstUsage[key], 0);
      assert.ok(total <= Math.floor((state.lastSample.timestamp - firstTimestamp) / 1000), 'two windows never spend more than one elapsed timeline');
    }
    previous = state.usageSeconds;
  }
}
