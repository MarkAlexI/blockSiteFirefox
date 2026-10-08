import assert from 'node:assert/strict';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(read, check, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  let value;
  do { value = await read(); if (check(value)) return value; await pause(25); } while (Date.now() < end);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

// Compile in Node, then evaluate through the existing browser protocol. No eval
// or Function runs inside the extension and no CSP setting is changed.
export function readerView(page) {
  return { evaluate: (fn, input = null) => page.evaluate(
    new Function('input', `return (${fn.toString()})(window, input);`), input) };
}

export async function openToolbarPopup(host) {
  if (host.front) await host.front(); else await host.bringToFront();
  await host.evaluate(() => {
    let button = document.getElementById('__bdOpenToolbar');
    if (!button) { button = document.createElement('button'); button.id = '__bdOpenToolbar';
      button.textContent = 'E2E: open toolbar'; document.body.prepend(button); }
    button.onclick = () => {
      const api = globalThis.browser || chrome;
      window.__bdToolbarOpen = { pending: true };
      api.action.openPopup().then(() => { window.__bdToolbarOpen = { opened: true }; },
        error => { window.__bdToolbarOpen = { error: String(error) }; });
    };
  });
  if (host.locator) await host.locator('#__bdOpenToolbar').click();
  else await host.clickUnsettled('#__bdOpenToolbar');
  await until(() => host.evaluate(() => window.__bdToolbarOpen), value => !value?.pending, 'action.openPopup resolved');
  assert.equal((await host.evaluate(() => window.__bdToolbarOpen)).opened, true, 'native popup API succeeded');
  const token = await until(() => host.evaluate(() => {
    const api = globalThis.browser || chrome;
    const views = api.extension.getViews({ type: 'popup' }).filter(view => view.location.pathname === '/index.html');
    if (views.length !== 1 || views[0].document.readyState !== 'complete') return null;
    const view = views[0];
    if (!view.__bdDocumentToken) view.__bdDocumentToken = crypto.randomUUID();
    return view.__bdDocumentToken;
  }), Boolean, 'one native popup view');
  return { token, host, evaluate(fn, input = null) {
    return host.evaluate(new Function('input', `
      const api = globalThis.browser || chrome;
      const view = api.extension.getViews({type:'popup'}).find(v => v.__bdDocumentToken === ${JSON.stringify(token)});
      if (!view) throw new Error('Native toolbar popup document was closed');
      return (${fn.toString()})(view, input);`), input);
  } };
}

export async function toolbarCount(host) {
  return host.evaluate(() => (globalThis.browser || chrome).extension.getViews({ type: 'popup' }).length);
}

// Only delivery is gated. Native storage.get, timers and animation frames run;
// return values, frame timestamps and production callbacks are never invented.
export function installPopupProbe(view) {
  if (view.__bdPopupProbe) throw new Error('Probe already installed');
  const state = view.__bdPopupProbe = { reads: [], renders: [], messages: [], tasks: [], epoch: 0,
    holdRead: false, holdRows: false, holdFrames: false, heldReads: [], heldRows: [], heldFrames: [] };
  const combined = keys => Array.isArray(keys) && ['rules', 'ruleLists', 'rulesGeneration', 'dailyRuleUsage'].every(key => keys.includes(key));
  // Firefox exposes both namespaces; the production snapshot reader uses
  // chrome.storage even though other Popup code uses browser.storage.
  for (const area of new Set([view.chrome?.storage.local, view.browser?.storage.local].filter(Boolean))) {
    const originalGet = area.get.bind(area);
    area.get = (...args) => {
      if (!combined(args[0])) return originalGet(...args);
      const gated = state.holdRead;
      if (gated) state.holdRead = false;
      return (async () => {
        const raw = await originalGet(...args);
        const captured = structuredClone(raw);
        state.reads.push({ raw: captured, gated });
        if (gated) await new view.Promise(resolve => state.heldReads.push(resolve));
        state.lastRaw = captured;
        return raw;
      })();
    };
  }
  for (const runtime of new Set([view.chrome?.runtime, view.browser?.runtime].filter(Boolean))) {
    const originalSend = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = (...args) => {
      const message = args.find(arg => arg?.type?.startsWith('rules:'));
      if (message) state.messages.push(structuredClone(message));
      return originalSend(...args);
    };
  }
  const container = view.document.querySelector('#rules-container');
  let prototype = container, descriptor;
  while (prototype && !(descriptor = Object.getOwnPropertyDescriptor(prototype, 'innerHTML'))) prototype = Object.getPrototypeOf(prototype);
  const rows = () => [...container.querySelectorAll('.rule[data-rule-id]')].filter(row => row.dataset.ruleId !== 'null').map(row => {
    const status = row.querySelector('.rule-daily-limit-popup');
    const usage = status?.textContent.match(/([\d.]+)\s*\/\s*(\d+)/);
    return { id: Number(row.dataset.ruleId), url: row.querySelector('input')?.value,
      list: row.querySelector('.rule-list-popup')?.textContent || null,
      usage: usage ? [Number(usage[1]), Number(usage[2])] : null,
      exhausted: Boolean(status?.classList.contains('limit-reached')) };
  }).sort((a, b) => a.id - b.id);
  const record = source => state.renders.push({ source, epoch: state.epoch,
    raw: state.renderRaw || null, rows: rows() });
  Object.defineProperty(container, 'innerHTML', { configurable: true,
    get() { return descriptor.get.call(this); }, set(value) {
      state.epoch++; state.renderRaw = state.lastRaw; descriptor.set.call(this, value); record('clear');
    } });
  const insert = container.insertAdjacentElement.bind(container);
  container.insertAdjacentElement = (...args) => {
    const result = insert(...args); state.tasks.push('row-insert'); record('insert'); return result;
  };
  state.observer = new view.MutationObserver(() => record('mutation'));
  state.observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
  const timeout = view.setTimeout.bind(view);
  view.setTimeout = (callback, milliseconds, ...args) => {
    const row = typeof callback === 'function' && callback.toString().includes('insertAdjacentElement');
    if (!row) return timeout(callback, milliseconds, ...args);
    return timeout(() => {
      state.tasks.push('native-row-timer');
      if (state.holdRows) state.heldRows.push(() => callback(...args));
      else callback(...args);
    }, milliseconds);
  };
  const frame = view.requestAnimationFrame.bind(view);
  view.requestAnimationFrame = callback => {
    state.tasks.push('frame-requested');
    return frame(timestamp => {
      state.tasks.push('native-frame');
      if (state.holdFrames) state.heldFrames.push(() => callback(timestamp));
      else callback(timestamp);
    });
  };
  state.release = kind => {
    const key = { reads: 'holdRead', rows: 'holdRows', frames: 'holdFrames' }[kind];
    state[key] = false;
    const pending = state[{ reads: 'heldReads', rows: 'heldRows', frames: 'heldFrames' }[kind]].splice(0);
    for (const callback of pending) callback();
  };
  state.rows = rows;
  return true;
}

export function expectedPopupRows(raw) {
  const active = raw.activeRuleListId || 'general';
  const usage = { ...(raw.dailyRuleUsage?.usageSeconds || {}) };
  for (const remap of raw.pendingDailyUsageRemaps || []) {
    const old = `${remap.oldRuleId}:${remap.oldListId}`, next = `${remap.newRuleId}:${remap.newListId}`;
    if (old === next) continue;
    if (Object.hasOwn(usage, old)) { usage[next] = Math.max(usage[next] || 0, usage[old]); delete usage[old]; }
  }
  return (raw.rules || []).flatMap(rule => {
    const assignment = rule.isWhitelist ? rule.assignments[0] : rule.assignments?.find(item => item.listId === active);
    if (!assignment) return [];
    const minutes = assignment.blockingMode === 'daily_limit' ? assignment.dailyLimit.minutes : null;
    const spent = usage[`${rule.id}:${assignment.listId}`] || 0;
    return [{ id: rule.id, url: rule.blockURL,
      list: rule.isWhitelist || assignment.listId === 'general' ? null : raw.ruleLists.find(list => list.id === assignment.listId).name,
      usage: minutes === null ? null : [Math.floor(Math.min(spent, minutes * 60) / 6) / 10, minutes],
      exhausted: minutes !== null && spent >= minutes * 60 }];
  }).sort((a, b) => a.id - b.id);
}

export function assertRenderTrace(trace) {
  assert.ok(trace.some(event => event.source === 'insert'), 'at least one actual row insertion observed');
  for (const event of trace) {
    assert.ok(event.raw, `render ${event.epoch} has a captured native snapshot`);
    const expected = expectedPopupRows(event.raw);
    assert.equal(new Set(event.rows.map(row => row.id)).size, event.rows.length, 'no duplicate rows in any render');
    for (const row of event.rows) assert.deepEqual(row, expected.find(item => item.id === row.id),
      `render ${event.epoch}, generation ${event.raw.rulesGeneration}, rule ${row.id}`);
  }
}
