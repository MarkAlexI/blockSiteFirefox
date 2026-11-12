// Independent of module imports and extension APIs: even a failed Options
// bootstrap must leave an actionable message instead of an empty rule list.
(() => {
  const banner = document.getElementById('options-recovery');
  if (!banner) return;
  const message = document.getElementById('options-recovery-message');
  const reload = document.getElementById('options-recovery-reload');
  const copy = document.getElementById('options-recovery-copy');
  const output = document.getElementById('options-recovery-report');
  const status = document.getElementById('options-recovery-status');
  const table = document.getElementById('rules-table');
  const targets = ['quick-add-rule', 'add-rule', 'add-whitelist-rule', 'open-rule-packs',
    'rule-packs-add', 'rule-lists-panel', 'categories-container', 'rules-table',
    'rules-management-panel'].map(id => document.getElementById(id)).filter(Boolean);
  const originalInert = new Map(targets.map(element => [element, element.inert === true]));
  let state = 'loading', timer = null, disposed = false;
  const pageVersion = '5.6.6';
  const failureKey = 'bdOptionsRecoveryFailureV1';
  const stageNames = ['module', 'setup', 'access', 'rules', 'lists', 'usage', 'connection', 'render'];
  const states = ['idle', 'pending', 'ok', 'error'];
  const codes = ['context_invalidated', 'no_receiver', 'channel_closed', 'rules_health_forbidden',
    'rules_connection_timeout', 'rules_connection_unavailable', 'unknown'];
  const schemes = ['chrome-extension:', 'moz-extension:', 'kiwi-extension:'];
  const stages = Object.fromEntries(stageNames.map(name => [name, { state: name === 'module' ? 'pending' : 'idle' }]));
  let failureRecorded = false;
  const fallback = {
    options_rules_loading: 'Loading rules…',
    options_rules_unavailable: 'Rules could not be loaded. Reload this page. If the problem continues, fully close and restart your browser, then reopen Settings.',
    options_reload_page: 'Reload page',
    diagnosticscopy: 'Copy Report',
    diagnosticstitle: 'Diagnostics',
    diagnosticscopied: 'Diagnostic report copied.',
    diagnosticserror: 'Diagnostics failed'
  };
  const text = key => {
    try {
      const api = globalThis.browser || globalThis.chrome;
      return api?.i18n?.getMessage(key) || fallback[key];
    } catch { return fallback[key]; }
  };
  const version = value => typeof value === 'string' && /^\d{1,3}(?:\.\d{1,5}){1,3}$/.test(value) ? value : 'unknown';
  const scheme = value => schemes.includes(value) ? value : 'unknown';
  const errorCode = error => {
    if (codes.includes(error?.code)) return error.code;
    const value = typeof error?.message === 'string' ? error.message : '';
    if (/extension context invalidated/i.test(value)) return 'context_invalidated';
    if (/receiving end does not exist|could not establish connection/i.test(value)) return 'no_receiver';
    if (/message (?:port|channel).*closed|channel closed/i.test(value)) return 'channel_closed';
    return 'unknown';
  };
  const environment = () => {
    let runtimeVersion = 'unknown', runtimeScheme = 'unknown';
    try {
      const runtime = (globalThis.browser || globalThis.chrome)?.runtime;
      runtimeVersion = version(runtime?.getManifest()?.version);
      runtimeScheme = scheme(new URL(runtime.getURL('options/options.html')).protocol);
    } catch { /* A dead extension context must not break its own report. */ }
    return { runtimeVersion, runtimeScheme, pageScheme: scheme(window.location.protocol) };
  };
  // Rebuild only this fixed schema, including when reading our own stored record.
  // Never retain raw messages, stacks, URLs, IDs, saved rules or license data.
  const sanitizeFailure = value => {
    if (value?.schemaVersion !== 1 || !Number.isFinite(value.at) || value.at <= 0 ||
        !['deadline', 'error'].includes(value.reason)) return null;
    return {
      schemaVersion: 1, pageVersion: version(value.pageVersion), at: value.at, reason: value.reason,
      code: codes.includes(value.code) ? value.code : 'unknown',
      environment: {
        runtimeVersion: version(value.environment?.runtimeVersion),
        runtimeScheme: scheme(value.environment?.runtimeScheme),
        pageScheme: scheme(value.environment?.pageScheme)
      },
      stages: Object.fromEntries(stageNames.map(name => {
        const item = value.stages?.[name];
        return [name, { state: states.includes(item?.state) ? item.state : 'idle',
          ...(item?.state === 'error' ? { code: codes.includes(item.code) ? item.code : 'unknown' } : {}) }];
      }))
    };
  };
  let lastFailure = null;
  try {
    const saved = window.localStorage.getItem(failureKey);
    if (saved && saved.length <= 8192) lastFailure = sanitizeFailure(JSON.parse(saved));
  } catch { /* Reports remain usable in memory if local storage is unavailable. */ }
  function mark(stage, value, error) {
    if (disposed || !stageNames.includes(stage) || !states.includes(value)) return;
    stages[stage] = { state: value, ...(value === 'error' ? { code: errorCode(error) } : {}) };
  }
  function track(stage, read, isCurrent = () => true) {
    if (isCurrent()) mark(stage, 'pending');
    let result;
    try { result = read(); }
    catch (error) {
      if (isCurrent()) mark(stage, 'error', error);
      return Promise.reject(error);
    }
    return Promise.resolve(result).then(value => {
      if (isCurrent()) mark(stage, 'ok');
      return value;
    }, error => {
      if (isCurrent()) mark(stage, 'error', error);
      throw error;
    });
  }
  function getReport() {
    return JSON.parse(JSON.stringify({ schemaVersion: 1,
      current: { pageVersion, state, environment: environment(), stages }, lastFailure }));
  }
  function clearFailure() {
    lastFailure = null;
    try { window.localStorage.removeItem(failureKey); } catch { /* Best effort local cleanup. */ }
  }
  const lock = locked => {
    for (const element of targets) element.inert = locked || originalInert.get(element);
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const setState = value => {
    state = value;
    banner.dataset.state = value;
    table?.setAttribute('aria-busy', String(value === 'loading'));
  };
  function fail(error) {
    if (disposed) return;
    clearTimer();
    setState('failed');
    if (!failureRecorded) {
      failureRecorded = true;
      lastFailure = sanitizeFailure({ schemaVersion: 1, pageVersion, at: Date.now(),
        reason: error ? 'error' : 'deadline', code: errorCode(error), environment: environment(), stages });
      try { window.localStorage.setItem(failureKey, JSON.stringify(lastFailure)); } catch { /* Keep the in-memory record. */ }
    }
    lock(true);
    message.textContent = text('options_rules_unavailable');
    reload.textContent = text('options_reload_page');
    if (copy) copy.textContent = text('diagnosticscopy');
    banner.hidden = false;
    const placeholder = document.getElementById('rules-loading-message');
    if (placeholder) {
      placeholder.setAttribute('data-i18n', 'options_rules_unavailable');
      placeholder.textContent = message.textContent;
    }
  }
  function begin() {
    if (disposed) return;
    setState('loading');
    // Repeated refresh requests cannot postpone a stuck bootstrap forever.
    if (timer === null) {
      failureRecorded = false;
      timer = setTimeout(fail, 10_000);
    }
  }
  function ready() {
    if (disposed) return;
    clearTimer();
    setState('ready');
    banner.hidden = true;
    lock(false);
  }
  function dispose() {
    disposed = true;
    clearTimer();
  }
  reload.addEventListener('click', () => window.location.reload());
  copy?.addEventListener('click', async () => {
    // The report and manual-copy fallback need neither imports nor a live worker.
    const report = JSON.stringify(getReport(), null, 2);
    if (output) {
      output.value = report;
      output.hidden = false;
      output.setAttribute('aria-label', text('diagnosticstitle'));
      output.focus?.();
      output.select?.();
    }
    let copied = false;
    try {
      if (globalThis.navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        copied = true;
      } else copied = document.execCommand?.('copy') === true;
    } catch { /* Leave the selected report visible for manual copying. */ }
    if (status) {
      status.textContent = text(copied ? 'diagnosticscopied' : 'diagnosticserror');
      status.hidden = false;
    }
  });
  window.addEventListener('beforeunload', dispose, { once: true });
  window.bdOptionsRecovery = Object.freeze({ begin, ready, fail, dispose, mark, track, getReport, clearFailure,
    get state() { return state; } });
  const placeholder = document.getElementById('rules-loading-message');
  if (placeholder) placeholder.textContent = text('options_rules_loading');
  lock(true);
  begin();
})();
