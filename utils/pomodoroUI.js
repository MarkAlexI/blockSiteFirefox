import { t } from '../scripts/t.js';
import { DEFAULT_POMODORO, POMODORO_KEY, readPomodoro } from './focusSession.js';

export class PomodoroUI {
  constructor(popup, api) {
    this.popup = popup;
    this.api = api;
    this.type = document.getElementById('focus-cycle-type');
    this.options = document.getElementById('pomodoro-options');
    this.panel = document.getElementById('pomodoro-panel');
    this.label = document.getElementById('pomodoro-label');
    this.timer = document.getElementById('pomodoro-timer');
    this.next = document.getElementById('pomodoro-next');
    this.stop = document.getElementById('pomodoro-stop');
    this.fields = Object.fromEntries(['breakMinutes', 'longBreakMinutes', 'rounds', 'autoContinue'].map(key =>
      [key, document.getElementById(`pomodoro-${key}`)]));
    this.type.addEventListener('change', () => { this.options.hidden = !this.selected; });
    this.fields.rounds.addEventListener('input', () => { this.fields.longBreakMinutes.parentElement.hidden = Number(this.fields.rounds.value) <= 4; });
    this.next.addEventListener('click', () => this.act('continue_pomodoro', 'start'));
    this.stop.addEventListener('click', () => this.act('stop_pomodoro', 'stop'));
  }

  get selected() { return this.type.value === 'pomodoro'; }

  async start() {
    for (const input of Object.values(this.fields)) {
      if (!input.disabled && !input.reportValidity()) return;
    }
    const paid = this.popup.isPro || this.popup.isLegacyUser;
    const config = { ...DEFAULT_POMODORO,
      autoContinue: Boolean(paid && this.fields.autoContinue.checked),
      ...(paid ? {
        workMinutes: Number(this.popup.focusDurationInput.value),
        breakMinutes: Number(this.fields.breakMinutes.value),
        longBreakMinutes: Number(this.fields.longBreakMinutes.value),
        rounds: Number(this.fields.rounds.value),
        isHardcore: this.popup.hardcoreModeCheckbox.checked,
        focusMode: this.popup.focusModeSelect.value
      } : {}) };
    await this.popup.runFocusAction('start', { type: 'start_pomodoro', config });
  }

  async act(type, kind) {
    if (this.busy || !this.cycle) return;
    const button = kind === 'start' ? this.next : this.stop;
    const id = this.cycle.id;
    this.busy = true;
    this.next.disabled = this.stop.disabled = true;
    try { await this.popup.runFocusAction(kind, { type, id, completedRounds: this.cycle.completedRounds }); }
    finally {
      this.busy = false;
      this.next.disabled = this.stop.disabled = false;
      if (!document.hidden && (document.activeElement === button || document.activeElement === document.body)) {
        const target = this.popup.focusViewState?.focusActive
          ? (this.popup.focusViewState.isHardcore ? this.popup.focusActiveLabel : this.popup.stopFocusBtn)
          : this.cycle ? this.next : this.popup.startFocusBtn;
        target.focus();
      }
    }
  }

  async recoverIfNeeded() {
    const stored = await this.api.storage.local.get(POMODORO_KEY);
    const cycle = readPomodoro(stored[POMODORO_KEY]);
    if (cycle && cycle.phase !== 'ready' && cycle.phaseEndTime <= Date.now()) {
      const response = await this.api.runtime.sendMessage({ type: 'pomodoro_status' });
      if (response?.success !== true) throw new Error('Pomodoro state unavailable');
    }
  }

  async render(focus) {
    const generation = this.renderGeneration = (this.renderGeneration || 0) + 1;
    const stored = await this.api.storage.local.get(POMODORO_KEY);
    if (generation !== this.renderGeneration) return;
    if (this.popup.focusDisposed) return;
    this.cycle = readPomodoro(stored[POMODORO_KEY]);
    clearInterval(this.interval);
    this.interval = null;
    const cycle = this.cycle;
    const paid = this.popup.isPro || this.popup.isLegacyUser;
    for (const key of ['breakMinutes', 'longBreakMinutes', 'rounds']) {
      this.fields[key].disabled = !paid;
      if (!paid) this.fields[key].value = DEFAULT_POMODORO[key];
    }
    this.fields.autoContinue.disabled = !paid;
    if (!paid) this.fields.autoContinue.checked = false;
    this.options.hidden = !this.selected;
    this.fields.longBreakMinutes.parentElement.hidden = Number(this.fields.rounds.value) <= 4;
    this.panel.hidden = !cycle;
    if (!cycle) return;
    this.popup.focusSection.classList.remove('hidden');
    this.popup.focusStartView.hidden = true;
    this.popup.focusStartView.classList.add('hidden');
    const waiting = cycle.phase !== 'work';
    this.next.hidden = this.stop.hidden = !waiting;
    this.timer.hidden = !waiting;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((cycle.phaseEndTime - Date.now()) / 1000));
      const phase = cycle.phase === 'work' ? t('focussessionheader') :
        cycle.phase === 'ready' || !remaining ? t('pomodoro_ready') : t('pomodoro_break');
      const round = Math.min(cycle.rounds, cycle.completedRounds + (cycle.phase === 'work' ? 1 : 0));
      const label = `Pomodoro · ${phase} · ${round}/${cycle.rounds}`;
      if (this.label.textContent !== label) this.label.textContent = label;
      this.timer.textContent = cycle.phase === 'ready' || !remaining ? '' :
        `${Math.floor(remaining / 60).toString().padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`;
      if (!remaining) {
        clearInterval(this.interval); this.interval = null;
        if (cycle.phase === 'break') void this.popup.updateFocusUI();
      }
    };
    update();
    if (cycle.phase === 'break' && cycle.phaseEndTime > Date.now()) this.interval = setInterval(update, 1000);
  }

  dispose() { clearInterval(this.interval); }
}
