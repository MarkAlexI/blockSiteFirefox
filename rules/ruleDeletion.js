// UI ownership only. The worker still validates captured rule/list revisions.
let nextDescription = 0;
const connected = node => Boolean(node?.ownerDocument?.documentElement.contains(node));
const identity = row => `${row.dataset.ruleId}:${row.dataset.assignmentListId || ''}`;
const restoreAttribute = (node, name, value) => value === null ? node.removeAttribute(name) : node.setAttribute(name, value);

export class RuleDeletionController {
  constructor(translate, notify) {
    this.translate = translate;
    this.notify = notify;
    this.states = new Map();
    this.timers = new Map();
    this.focusPlans = new Set();
    this.disposed = false;
  }

  run(button, remove, strict, label = null, options = {}) {
    if (this.disposed || !connected(button) || this.states.has(button)) return Promise.resolve();
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const state = { button, remove, label: label || button.textContent, options, resolve, reject,
      phase: strict ? 'waiting' : 'pending', originalText: button.textContent,
      disabled: button.getAttribute('aria-disabled'), busy: button.getAttribute('aria-busy') };
    this.states.set(button, state);
    state.parent = button.parentNode;
    state.parent.classList.add('rule-deletion-active');
    state.click = event => {
      event.preventDefault(); event.stopImmediatePropagation?.();
      if (state.phase === 'ready') return this.commit(state);
    };
    state.key = event => {
      if (event.key === 'Escape' && state.phase !== 'pending') {
        event.preventDefault(); event.stopPropagation(); this.finish(state, true);
      } else if (event.currentTarget === button && (event.key === 'Enter' || event.key === ' ') &&
          (event.repeat || state.phase !== 'ready')) {
        // A key held through the countdown is not a separate confirmation.
        event.preventDefault();
      }
    };
    button.addEventListener('click', state.click, true);
    button.addEventListener('keydown', state.key);
    button.setAttribute('aria-disabled', 'true');
    if (strict) this.wait(state);
    else this.commit(state);
    return result;
  }

  wait(state) {
    const { button, options } = state, document = button.ownerDocument;
    let seconds = options.countdownSeconds ?? 10;
    const help = document.createElement('span');
    help.id = `rule-delete-help-${++nextDescription}`;
    const tableRow = state.parent.parentNode?.tagName === 'TR' ? state.parent.parentNode : null;
    help.className = tableRow ? 'rule-delete-description' : 'rule-delete-help';
    help.textContent = this.translate('rule_delete_wait', seconds);
    const timer = document.createElement('span');
    timer.className = tableRow ? 'rule-delete-timer' : 'rule-delete-help';
    timer.setAttribute('role', 'timer'); timer.setAttribute('aria-live', 'off');
    timer.setAttribute('aria-label', state.label);
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'delete-cancel';
    cancel.textContent = this.translate('cancelbtn');
    cancel.setAttribute('aria-label', `${cancel.textContent}: ${button.getAttribute('aria-label') || state.label}`);
    cancel.addEventListener('click', () => this.finish(state, true));
    cancel.addEventListener('keydown', state.key);
    const controls = document.createElement('span');
    controls.className = 'rule-delete-controls'; controls.appendChild(cancel);
    if (tableRow) {
      const row = document.createElement('tr'), cell = document.createElement('td'), panel = document.createElement('div');
      row.className = 'rule-deletion-row'; cell.colSpan = tableRow.children.length;
      panel.className = 'rule-deletion-panel'; panel.append(help, timer, controls);
      cell.appendChild(panel); row.appendChild(cell); tableRow.after(row); state.tableRow = row;
    } else button.parentNode.append(help, timer, controls);
    state.help = help; state.timer = timer; state.cancel = cancel; state.controls = controls;
    const descriptions = (button.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    button.setAttribute('aria-describedby', [...descriptions, help.id].join(' '));
    button.classList.add('countdown-active');
    this.notify(help.textContent);
    const render = () => { if (!state.tableRow) button.textContent = `${state.label} (${seconds})`; timer.textContent = String(seconds); };
    render();
    const id = setInterval(() => {
      if (!connected(button)) { this.finish(state); return; }
      if (--seconds > 0) { render(); return; }
      clearInterval(id); this.timers.delete(id);
      state.phase = 'ready'; timer.textContent = '0';
      button.classList.remove('countdown-active'); button.classList.add('delete-ready');
      button.setAttribute('aria-disabled', 'false');
      if (!state.tableRow) button.textContent = `${state.label} ✓`;
      help.textContent = this.translate('rule_delete_ready', button.getAttribute('aria-label') || state.label);
      this.notify(help.textContent);
      const expire = () => {
        if (state.phase !== 'ready') return;
        const focused = document.activeElement === button || document.activeElement === cancel;
        if (!document.hidden && (focused || state.hovered)) this.armExpiry(state, expire);
        else this.finish(state);
      };
      this.armExpiry(state, expire);
    }, 1000);
    state.interval = id; this.timers.set(id, id);
    state.enter = () => { state.hovered = true; };
    state.leave = () => { state.hovered = false; };
    for (const control of [button, cancel]) {
      control.addEventListener('pointerenter', state.enter);
      control.addEventListener('pointerleave', state.leave);
    }
  }

  armExpiry(state, expire) {
    const id = setTimeout(() => { this.timers.delete(id); expire(); }, (state.options.confirmSeconds ?? 5) * 1000);
    state.expiry = id; this.timers.set(id, id);
  }

  async commit(state) {
    if (state.committing || !connected(state.button) || this.disposed) return;
    state.committing = true; state.phase = 'pending';
    clearInterval(state.interval); clearTimeout(state.expiry);
    this.timers.delete(state.interval); this.timers.delete(state.expiry);
    const { button, options } = state;
    this.rememberFocus(options.container, options.fallback);
    button.classList.remove('countdown-active', 'delete-ready');
    button.setAttribute('aria-disabled', 'true'); button.setAttribute('aria-busy', 'true');
    if (state.cancel) state.cancel.disabled = true;
    try { await state.remove(); }
    catch (error) { state.error = error; }
    finally { this.finish(state); }
  }

  finish(state, cancelled = false) {
    if (this.states.get(state.button) !== state) return;
    const { button } = state, document = button.ownerDocument;
    const cancelFocused = document.activeElement === state.cancel;
    clearInterval(state.interval); clearTimeout(state.expiry);
    this.timers.delete(state.interval); this.timers.delete(state.expiry);
    button.removeEventListener('click', state.click, true);
    button.removeEventListener('keydown', state.key);
    for (const control of [button, state.cancel].filter(Boolean)) {
      control.removeEventListener('pointerenter', state.enter);
      control.removeEventListener('pointerleave', state.leave);
    }
    if (state.help) {
      const descriptions = (button.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== state.help.id);
      if (descriptions.length) button.setAttribute('aria-describedby', descriptions.join(' '));
      else button.removeAttribute('aria-describedby');
    }
    state.help?.remove(); state.timer?.remove(); state.controls?.remove(); state.tableRow?.remove();
    button.textContent = state.originalText;
    button.classList.remove('countdown-active', 'delete-ready');
    restoreAttribute(button, 'aria-disabled', state.disabled); restoreAttribute(button, 'aria-busy', state.busy);
    this.states.delete(button);
    state.parent.classList.remove('rule-deletion-active');
    if (connected(button)) {
      for (const plan of [...this.focusPlans]) if (plan.start === button) this.dropFocus(plan);
    }
    if (cancelFocused && connected(button) && !document.hidden && !this.disposed) button.focus();
    if (cancelled && !this.disposed) this.notify(this.translate('rule_delete_cancelled'));
    if (state.error) state.reject(state.error); else state.resolve();
  }

  rememberFocus(container, fallback) {
    if (!container) return;
    const document = container.ownerDocument, active = document.activeElement;
    if (!active?.classList?.contains('delete-btn') || !container.contains(active)) return;
    if ([...this.focusPlans].some(plan => plan.start === active)) return;
    const rows = [...container.children].filter(row => row.dataset.ruleId && row.querySelector('.delete-btn'));
    const index = rows.findIndex(row => row.contains(active)); if (index < 0) return;
    const plan = { container, fallback, start: active, document,
      candidates: [rows[index], ...rows.slice(index + 1), ...rows.slice(0, index).reverse()].map(identity) };
    plan.focus = event => { if (event.target !== document.body && event.target !== plan.start) this.dropFocus(plan); };
    document.addEventListener('focusin', plan.focus);
    this.focusPlans.add(plan);
  }

  restoreFocus(container) {
    for (const state of [...this.states.values()]) {
      if (state.phase !== 'pending' && !connected(state.button)) this.finish(state);
    }
    for (const plan of [...this.focusPlans]) {
      if (plan.container !== container) continue;
      const { document } = plan;
      if (connected(plan.start)) continue;
      this.dropFocus(plan);
      if (this.disposed || document.hidden || document.querySelector('dialog[open]') ||
          container.classList.contains('focus-lock-active') ||
          (document.activeElement !== document.body && document.activeElement !== plan.start)) continue;
      const rows = [...container.children];
      const target = plan.candidates.map(key => rows.find(row => identity(row) === key)?.querySelector('.delete-btn'))
        .find(button => connected(button) && !button.disabled) || plan.fallback?.();
      if (connected(target) && !target.disabled && !target.hidden) target.focus();
    }
  }

  dropFocus(plan) { plan.document.removeEventListener('focusin', plan.focus); this.focusPlans.delete(plan); }

  cancel(button) { const state = this.states.get(button); if (state && state.phase !== 'pending') this.finish(state); }

  cleanup() {
    this.disposed = true;
    for (const state of [...this.states.values()]) this.finish(state);
    for (const plan of [...this.focusPlans]) this.dropFocus(plan);
  }
}
