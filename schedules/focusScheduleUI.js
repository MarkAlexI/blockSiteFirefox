import { t } from '../scripts/t.js';
import { sendRuntimeMessage } from '../rules/rulesClient.js';
import { validateFocusSchedule } from './focusSchedule.js';

export class FocusScheduleUI {
  constructor(root, { send = sendRuntimeMessage, translate = t } = {}) {
    this.root = root;
    this.send = send;
    this.t = translate;
    this.form = root.querySelector('form');
    this.status = root.querySelector('[data-focus-status]');
    this.skipped = root.querySelector('[data-focus-skipped]');
    this.notice = root.querySelector('[data-focus-notice]');
    this.skip = root.querySelector('[data-focus-skip]');
    this.accessNote = root.querySelector('[data-focus-access]');
    this.busy = false;
    this.state = null;
    this.dirty = false;
    this.loadGeneration = 0;
  }

  async init() {
    this.form?.addEventListener('input', () => { this.dirty = true; });
    this.form?.addEventListener('submit', event => {
      event.preventDefault();
      void this.save();
    });
    this.root.querySelector('[data-focus-reset]')?.addEventListener('click', () => {
      this.dirty = false;
      this.notice.textContent = '';
      void this.refresh(true);
    });
    this.skip.addEventListener('click', () => {
      if (this.state?.next) void this.mutate({ type: 'focus_schedule_skip', key: this.state.next.key });
    });
    await this.refresh(true);
  }

  async request(message) {
    const response = await this.send(message);
    if (!response?.success) throw Object.assign(new Error('Focus schedule request failed'), { code: response?.code });
    return response;
  }

  showError(error) {
    const key = error?.code === 'pro_required' ? 'prorequired'
      : error?.code === 'schedule_changed' ? 'focus_schedule_changed'
        : error?.code === 'invalid_focus_schedule' ? 'invalidschedule'
          : 'errorsavingsettings';
    this.notice.textContent = this.t(key);
  }

  async refresh(fill = false) {
    if (this.busy) return;
    const generation = ++this.loadGeneration;
    try {
      const state = await this.request({ type: 'focus_schedule_get' });
      if (generation !== this.loadGeneration || this.busy) return;
      this.render(state, fill || !this.dirty);
    } catch (error) {
      if (generation === this.loadGeneration) this.showError(error);
    }
  }

  render(state, fill = false) {
    // Keep the revision paired with the form values, even if another view saves.
    this.state = state;
    if (this.form && fill) {
      this.formRevision = state.revision;
      this.form.elements.enabled.checked = state.config.enabled;
      this.form.elements.startTime.value = state.config.startTime;
      this.form.elements.durationMinutes.value = state.config.durationMinutes;
      for (const input of this.form.querySelectorAll('[name="day"]')) {
        input.checked = state.config.days.includes(Number(input.value));
      }
    }
    const format = timestamp => new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(timestamp));
    this.status.textContent = !state.hasAccess ? this.t('prorequired')
      : state.next ? this.t('focus_schedule_next', format(state.next.startTime))
        : this.t('focus_schedule_off');
    this.skipped.textContent = state.skipped
      ? this.t('focus_schedule_skipped', format(state.skipped.startTime)) : '';
    this.skip.hidden = !state.next || !state.hasAccess;
    if (this.accessNote) this.accessNote.hidden = state.hasAccess;
    this.setBusy(this.busy);
  }

  setBusy(busy) {
    this.busy = busy;
    this.skip.disabled = busy || !this.state;
    if (!this.form) return;
    for (const input of this.form.querySelectorAll('input')) {
      // An expired subscriber can still turn an existing schedule off.
      const canDisable = input.name === 'enabled' && this.state?.config.enabled;
      input.disabled = busy || !this.state || (!this.state.hasAccess && !canDisable);
    }
    for (const button of this.form.querySelectorAll('button')) {
      button.disabled = busy || !this.state;
    }
  }

  async save() {
    if (this.busy || !this.state) return;
    const durationMinutes = Number(this.form.elements.durationMinutes.value);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240) {
      this.notice.textContent = this.t('focussessioninvalidduration');
      return;
    }
    const config = {
      enabled: this.form.elements.enabled.checked,
      startTime: this.form.elements.startTime.value,
      durationMinutes,
      days: [...this.form.querySelectorAll('[name="day"]')].filter(input => input.checked).map(input => Number(input.value))
    };
    try { validateFocusSchedule(config); } catch (error) { this.showError(error); return; }
    await this.mutate({ type: 'focus_schedule_save', config, revision: this.formRevision }, true);
  }

  async mutate(message, fill = false) {
    if (this.busy) return;
    ++this.loadGeneration;
    this.setBusy(true);
    this.notice.textContent = '';
    try {
      const state = await this.request(message);
      if (fill) this.dirty = false;
      this.render(state, fill);
      if (fill) this.notice.textContent = this.t('settingssaved');
    } catch (error) {
      this.showError(error);
    } finally {
      this.setBusy(false);
    }
  }
}

export function revealFocusSchedule(root, hash) {
  if (root?.tagName !== 'DETAILS' || hash !== '#focus-schedule') return false;
  root.open = true;
  root.scrollIntoView({ block: 'start' });
  return true;
}

export async function mountFocusSchedule(root, storage) {
  if (!root) return;
  const ui = new FocusScheduleUI(root);
  ui.setBusy(false);
  await ui.init();
  const onChange = (changes, area) => {
    if ((area === 'local' && (changes.focusSchedule || changes.focusSession)) ||
        (area === 'sync' && changes.credentials)) void ui.refresh();
  };
  storage.onChanged.addListener(onChange);
  const interval = setInterval(() => { if (!document.hidden) void ui.refresh(); }, 30_000);
  window.addEventListener('pagehide', () => {
    clearInterval(interval);
    storage.onChanged.removeListener(onChange);
  }, { once: true });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector('[data-focus-schedule]');
    const reveal = () => revealFocusSchedule(root, window.location.hash);
    reveal();
    window.addEventListener('hashchange', reveal);
    void mountFocusSchedule(root, browser.storage);
  });
}
