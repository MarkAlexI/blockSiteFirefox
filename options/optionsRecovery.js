// Independent of module imports and extension APIs: even a failed Options
// bootstrap must leave an actionable message instead of an empty rule list.
(() => {
  const banner = document.getElementById('options-recovery');
  if (!banner) return;
  const message = document.getElementById('options-recovery-message');
  const reload = document.getElementById('options-recovery-reload');
  const table = document.getElementById('rules-table');
  const targets = ['quick-add-rule', 'add-rule', 'add-whitelist-rule', 'open-rule-packs',
    'rule-packs-add', 'rule-lists-panel', 'categories-container', 'rules-table',
    'rules-management-panel'].map(id => document.getElementById(id)).filter(Boolean);
  const originalInert = new Map(targets.map(element => [element, element.inert === true]));
  let state = 'loading', timer = null, disposed = false;
  const fallback = {
    options_rules_loading: 'Loading rules…',
    options_rules_unavailable: 'Rules could not be loaded. Reload this page. If the problem continues, fully close and restart your browser, then reopen Settings.',
    options_reload_page: 'Reload page'
  };
  const text = key => {
    try {
      const api = globalThis.browser || globalThis.chrome;
      return api?.i18n?.getMessage(key) || fallback[key];
    } catch { return fallback[key]; }
  };
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
  function fail() {
    if (disposed) return;
    clearTimer();
    setState('failed');
    lock(true);
    message.textContent = text('options_rules_unavailable');
    reload.textContent = text('options_reload_page');
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
    if (timer === null) timer = setTimeout(fail, 10_000);
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
  window.addEventListener('beforeunload', dispose, { once: true });
  window.bdOptionsRecovery = Object.freeze({ begin, ready, fail, dispose, get state() { return state; } });
  const placeholder = document.getElementById('rules-loading-message');
  if (placeholder) placeholder.textContent = text('options_rules_loading');
  lock(true);
  begin();
})();
