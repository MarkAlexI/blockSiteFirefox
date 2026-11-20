import { t } from '../scripts/t.js';
import { keepDialogFocus, restoreDialogFocus } from '../dom/dialogFocus.js';
import { DEFAULT_POMODORO, POMODORO_KEY, readPomodoro, getPomodoroDurationMs,
  isPomodoroHardcoreLocked } from './focusSession.js';

const formatEnd = time => new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(time);

export class PomodoroUI {
  constructor(popup, api) {
    this.popup = popup;
    this.api = api;
    const get = id => document.getElementById(id);
    this.type = get('focus-cycle-type');
    this.options = get('pomodoro-options');
    this.panel = get('pomodoro-panel');
    this.label = get('pomodoro-label');
    this.timer = get('pomodoro-timer');
    this.next = get('pomodoro-next');
    this.stop = get('pomodoro-stop');
    this.preview = get('pomodoro-preview');
    this.note = get('pomodoro-action-note');
    this.lockNote = get('pomodoro-lock-note');
    this.dialog = get('pomodoro-end-dialog');
    this.cancel = get('pomodoro-end-cancel');
    this.fields = Object.fromEntries(['breakMinutes', 'longBreakMinutes', 'rounds', 'autoContinue'].map(key =>
      [key, get(`pomodoro-${key}`)]));
    this.type.addEventListener('change', () => this.syncControls());
    for (const input of [popup.focusDurationInput, popup.hardcoreModeCheckbox, ...Object.values(this.fields)]) {
      input.addEventListener('input', () => this.syncControls());
      input.addEventListener('change', () => this.syncControls());
    }
    this.next.addEventListener('click', () => this.act('continue_pomodoro', 'start'));
    this.stop.addEventListener('click', () => this.act('stop_pomodoro', 'stop'));
    this.dialog.addEventListener('keydown', event => keepDialogFocus(event, this.dialog));
    this.dialog.addEventListener('close', () => {
      const resolve = this.confirmResolve;
      this.confirmResolve = null;
      // A storage transition may close the dialog from a render that read Focus
      // before it read the new cycle. Wait for a fresh, settled view before
      // restoring focus; otherwise every candidate can still be hidden.
      if (!this.disposed) void this.restoreAfterConfirmation();
      resolve?.(this.dialog.returnValue === 'end');
    });
  }

  async restoreAfterConfirmation() {
    try { await this.popup.updateFocusUI(); }
    catch (error) { this.popup.logger?.info('Pomodoro confirmation refresh failed:', error); return; }
    if (this.disposed || this.popup.focusDisposed || document.hidden) return;
    // Let the browser finish removing the dialog from its modal top layer.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (this.disposed || this.popup.focusDisposed || document.hidden || this.busy ||
        this.popup.focusAction || document.querySelector('dialog[open]')) return;
    const focused = document.activeElement;
    if (focused !== document.body && !this.dialog.contains(focused) &&
        ![this.stop, this.next, this.popup.startFocusBtn, this.popup.stopFocusBtn, this.popup.focusActiveLabel].includes(focused)) return;
    restoreDialogFocus(this.stop, this.next, this.popup.startFocusBtn, this.popup.stopFocusBtn, this.popup.focusActiveLabel);
  }

  get selected() { return this.type.value === 'pomodoro'; }
  get paid() { return this.popup.isPro || this.popup.isLegacyUser; }

  config() {
    return { ...DEFAULT_POMODORO,
      autoContinue: Boolean(this.paid && this.fields.autoContinue.checked),
      ...(this.paid ? {
        workMinutes: Number(this.popup.focusDurationInput.value),
        breakMinutes: Number(this.fields.breakMinutes.value),
        longBreakMinutes: Number(this.fields.longBreakMinutes.value),
        rounds: Number(this.fields.rounds.value),
        isHardcore: this.popup.hardcoreModeCheckbox.checked,
        focusMode: this.popup.focusModeSelect.value
      } : {}) };
  }

  syncControls() {
    for (const key of ['breakMinutes', 'longBreakMinutes', 'rounds']) {
      this.fields[key].disabled = !this.paid;
      if (!this.paid) this.fields[key].value = DEFAULT_POMODORO[key];
    }
    const hardcore = this.paid && this.selected && this.popup.hardcoreModeCheckbox.checked;
    this.fields.autoContinue.disabled = !this.paid || hardcore;
    if (!this.paid) this.fields.autoContinue.checked = false;
    else if (hardcore) this.fields.autoContinue.checked = true;
    this.options.hidden = !this.selected;
    this.fields.longBreakMinutes.parentElement.hidden = Number(this.fields.rounds.value) <= 4;
    this.preview.hidden = !hardcore;
    if (hardcore) {
      const config = this.config();
      const valid = [config.workMinutes, config.breakMinutes, config.longBreakMinutes].every(n => Number.isInteger(n) && n >= 1 && n <= 240) &&
        Number.isInteger(config.rounds) && config.rounds >= 1 && config.rounds <= 12;
      this.preview.textContent = t('pomodoro_hardcore_note') + (valid ? ` ${t('pomodoro_until', formatEnd(Date.now() + getPomodoroDurationMs(config)))}` : '');
    }
  }

  async start() {
    this.syncControls();
    for (const input of Object.values(this.fields)) {
      if (!input.disabled && !input.reportValidity()) return;
    }
    await this.popup.runFocusAction('start', { type: 'start_pomodoro', config: this.config() });
  }

  confirmEnd(snapshot) {
    this.confirmSnapshot = snapshot;
    this.dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      this.confirmResolve = resolve;
      this.dialog.showModal();
      this.cancel.focus();
    });
  }

  syncActions() {
    const pending = Boolean(this.busy || this.popup.focusAction);
    this.next.disabled = this.stop.disabled = pending;
    if (pending) this.panel.setAttribute('aria-busy', 'true');
    else this.panel.removeAttribute('aria-busy');
  }

  repairPendingFocus() {
    if (!this.focusRepairPending || this.disposed || document.hidden || this.busy ||
        this.popup.focusAction || document.querySelector('dialog[open]')) return;
    const focused = document.activeElement;
    if (focused !== document.body && focused !== this.next && focused !== this.stop) {
      this.focusRepairPending = false;
      return;
    }
    const target = !this.cycle ? this.popup.startFocusBtn : this.cycle.phase === 'work'
      ? (this.cycle.isHardcore ? this.popup.focusActiveLabel : this.popup.stopFocusBtn) : this.next;
    restoreDialogFocus(target);
    if (document.activeElement === target) this.focusRepairPending = false;
  }

  async act(type, kind) {
    if (this.busy || this.confirmResolve || this.popup.focusAction || !this.cycle || this.disposed) return;
    const button = kind === 'start' ? this.next : this.stop;
    const snapshot = { id: this.cycle.id, completedRounds: this.cycle.completedRounds, phase: this.cycle.phase };
    if (kind === 'stop') {
      if (isPomodoroHardcoreLocked(this.cycle) || !await this.confirmEnd(snapshot)) return;
      if (this.disposed || !this.cycle || Object.keys(snapshot).some(key => this.cycle[key] !== snapshot[key])) return;
    }
    this.busy = true;
    this.syncActions();
    try { await this.popup.runFocusAction(kind, { type, ...snapshot }); }
    finally {
      this.busy = false;
      this.syncActions();
      if (!this.disposed && !document.hidden && (document.activeElement === button || document.activeElement === document.body)) {
        restoreDialogFocus(this.popup.focusViewState?.focusActive
          ? (this.popup.focusViewState.isHardcore ? this.popup.focusActiveLabel : this.popup.stopFocusBtn)
          : this.cycle ? this.next : this.popup.startFocusBtn);
      }
    }
  }

  async recoverIfNeeded() {
    const stored = await this.api.storage.local.get(POMODORO_KEY);
    const cycle = readPomodoro(stored[POMODORO_KEY]);
    if (cycle && ((cycle.phase !== 'ready' && cycle.phaseEndTime <= Date.now()) ||
        (cycle.isHardcore && (!cycle.hardcoreEndTime || cycle.hardcoreEndTime <= Date.now())))) {
      const response = await this.api.runtime.sendMessage({ type: 'pomodoro_status' });
      if (response?.success !== true) throw new Error('Pomodoro state unavailable');
    }
  }

  async render(focus) {
    const generation = this.renderGeneration = (this.renderGeneration || 0) + 1;
    const stored = await this.api.storage.local.get(POMODORO_KEY);
    if (generation !== this.renderGeneration || this.popup.focusDisposed || this.disposed) return;
    this.cycle = readPomodoro(stored[POMODORO_KEY]);
    clearInterval(this.interval);
    this.interval = null;
    const cycle = this.cycle;
    if ((!cycle || cycle.phase === 'work') && [this.next, this.stop].includes(document.activeElement)) this.focusRepairPending = true;
    if (this.dialog.open && (!cycle || isPomodoroHardcoreLocked(cycle) ||
        Object.keys(this.confirmSnapshot).some(key => cycle[key] !== this.confirmSnapshot[key]))) this.dialog.close('cancel');
    this.syncControls();
    this.syncActions();
    this.panel.hidden = !cycle;
    this.popup.stopFocusBtn.textContent = t(cycle ? 'pomodoro_stop' : 'focussessionstop');
    this.popup.stopFocusBtn.classList.toggle('pomodoro-end', Boolean(cycle));
    if (!cycle) { this.repairPendingFocus(); return; }
    this.popup.focusSection.classList.remove('hidden');
    this.popup.focusStartView.hidden = true;
    this.popup.focusStartView.classList.add('hidden');
    const waiting = cycle.phase !== 'work';
    const locked = isPomodoroHardcoreLocked(cycle);
    this.popup.toggleUIAccessibility(Boolean(focus.focusActive || locked));
    this.next.hidden = !waiting;
    this.stop.hidden = !waiting || locked;
    this.timer.hidden = !waiting;
    this.repairPendingFocus();
    this.lockNote.hidden = !locked;
    if (locked) this.lockNote.textContent = `${t('pomodoro_hardcore_note')} ${t('pomodoro_until', formatEnd(cycle.hardcoreEndTime))}`;
    this.note.hidden = !waiting;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((cycle.phaseEndTime - Date.now()) / 1000));
      const breaking = cycle.phase === 'break' && remaining > 0;
      const phase = cycle.phase === 'work' ? t('focussessionheader') : breaking ? t('pomodoro_break') : t('pomodoro_ready');
      const round = Math.min(cycle.rounds, cycle.completedRounds + (cycle.phase === 'work' ? 1 : 0));
      const label = `Pomodoro · ${phase} · ${round}/${cycle.rounds}`;
      if (this.label.textContent !== label) this.label.textContent = label;
      this.next.textContent = t(breaking ? 'pomodoro_skip_break' : 'pomodoro_next');
      this.note.textContent = t(breaking && cycle.autoContinue ? 'pomodoro_auto_note' : 'pomodoro_manual_note');
      this.timer.textContent = !breaking ? '' :
        `${Math.floor(remaining / 60).toString().padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`;
      if ((cycle.isHardcore && cycle.hardcoreEndTime <= Date.now()) || (cycle.phase === 'break' && !remaining)) {
        clearInterval(this.interval); this.interval = null;
        void this.popup.updateFocusUI();
      }
    };
    update();
    if ((cycle.phase === 'break' && cycle.phaseEndTime > Date.now()) || locked) this.interval = setInterval(update, 1000);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.interval);
    if (this.dialog.open) this.dialog.close('cancel');
  }
}
