import { t } from '../scripts/t.js';
import { sendRuntimeMessage } from '../rules/rulesClient.js';
import { validateFocusSchedule } from './focusSchedule.js';
import { createFocusScheduleAnnouncer } from './focusScheduleAnnouncer.js';

function setText(element, text) {
  if (element.textContent === text) return false;
  element.textContent = text;
  return true;
}

const formatTime = timestamp => new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
}).format(new Date(timestamp));

export class FocusScheduleUI {
  constructor(root, { send = sendRuntimeMessage, translate = t } = {}) {
    this.root = root;
    this.send = send;
    this.t = translate;
    this.form = root.querySelector('form');
    this.status = root.querySelector('[data-focus-status]');
    this.skipped = root.querySelector('[data-focus-skipped]');
    this.notice = root.querySelector('[data-focus-notice]');
    this.announcements = createFocusScheduleAnnouncer(root.ownerDocument);
    // Upgrade retained markup to the same single action-feedback channel.
    this.status.removeAttribute('aria-live');
    this.notice.removeAttribute('aria-live');
    this.notice.removeAttribute('role');
    this.skip = root.querySelector('[data-focus-skip]');
    this.restore = root.querySelector('[data-focus-restore]');
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
      this.announcements.clear();
      setText(this.notice, '');
      void this.refresh(true);
    });
    this.skip.addEventListener('click', () => {
      if (this.state?.next) void this.mutate({ type: 'focus_schedule_skip', key: this.state.next.key,
        revision: this.state.revision, startTime: this.state.next.startTime });
    });
    this.restore?.addEventListener('click', () => {
      const target = this.state?.restorable;
      if (target && target.startTime > Date.now()) void this.mutate({ type: 'focus_schedule_restore',
        key: target.key, revision: this.state.revision, startTime: target.startTime });
      else void this.refresh();
    });
    await this.refresh(true);
  }

  async request(message) {
    const response = await this.send(message);
    if (!response?.success) throw Object.assign(new Error('Focus schedule request failed'), { code: response?.code });
    return response;
  }

  showNotice(text, repeat = true) {
    const changed = setText(this.notice, text);
    if (changed || repeat) this.announcements.announce(text);
  }

  showError(error, repeat = true) {
    const key = error?.code === 'pro_required' ? 'prorequired'
      : error?.code === 'schedule_changed' ? 'focus_schedule_changed'
        : error?.code === 'invalid_focus_schedule' ? 'invalidschedule'
          : 'errorsavingsettings';
    this.showNotice(this.t(key), repeat);
  }

  async refresh(fill = false) {
    if (this.busy) return;
    const generation = ++this.loadGeneration;
    try {
      const state = await this.request({ type: 'focus_schedule_get' });
      if (generation !== this.loadGeneration || this.busy) return;
      // Cancel clears dirty before loading; new input during the read wins.
      this.render(state, !this.dirty);
    } catch (error) {
      if (generation === this.loadGeneration) this.showError(error, false);
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
    setText(this.status, !state.hasAccess ? this.t('prorequired')
      : state.next ? this.t('focus_schedule_next', formatTime(state.next.startTime))
        : this.t('focus_schedule_off'));
    setText(this.skipped, state.skipped
      ? this.t('focus_schedule_skipped', formatTime(state.skipped.startTime)) : '');
    this.skip.hidden = !state.next || !state.hasAccess;
    if (this.restore) {
      this.restore.hidden = !state.hasAccess || !state.restorable || state.restorable.startTime <= Date.now();
      if (!this.restore.hidden) setText(this.restore, this.t('focus_schedule_restore', formatTime(state.restorable.startTime)));
    }
    if (this.accessNote) this.accessNote.hidden = state.hasAccess;
    this.setBusy(this.busy);
  }

  setBusy(busy) {
    this.busy = busy;
    if (busy) this.root.setAttribute('aria-busy', 'true');
    else this.root.removeAttribute('aria-busy');
    // Keep pending actions focusable. mutate() guards keyboard and pointer
    // repeats; native disabled would blur the action before its reply.
    for (const button of [this.skip, this.restore].filter(Boolean)) {
      button.disabled = !this.state;
      if (busy) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
    if (!this.form) return;
    for (const input of this.form.querySelectorAll('input')) {
      // An expired subscriber can still turn an existing schedule off.
      const canDisable = input.name === 'enabled' && this.state?.config.enabled;
      input.disabled = busy || !this.state || (!this.state.hasAccess && !canDisable);
    }
    for (const button of this.form.querySelectorAll('button')) {
      if (button === this.skip || button === this.restore) continue;
      button.disabled = busy || !this.state;
    }
  }

  async save() {
    if (this.busy || !this.state) return;
    const durationMinutes = Number(this.form.elements.durationMinutes.value);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 240) {
      this.showNotice(this.t('focussessioninvalidduration'));
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
    const doc = this.root.ownerDocument;
    let returnFocus = Boolean(this.restore && doc?.activeElement === this.restore);
    const changedFocus = event => { if (event.target !== this.restore) returnFocus = false; };
    if (returnFocus) {
      doc.addEventListener('focusin', changedFocus);
      doc.addEventListener('pointerdown', changedFocus);
    }
    let refresh = false;
    const actionTime = message.startTime ?? (message.type === 'focus_schedule_restore'
      ? this.state?.restorable?.startTime : this.state?.next?.startTime);
    ++this.loadGeneration;
    this.setBusy(true);
    this.announcements.clear();
    setText(this.notice, '');
    try {
      const state = await this.request(message);
      // An accepted own Skip/Undo proves its exact source revision was current
      // and did not edit config. A passive refresh cannot prove this (A-B-A).
      if (!fill && this.form && this.formRevision === message.revision &&
          this.state?.revision === message.revision && state.revision === message.revision + 1 &&
          JSON.stringify(this.state.config) === JSON.stringify(state.config)) {
        this.formRevision = state.revision;
      }
      if (fill) this.dirty = false;
      this.render(state, fill);
      if (fill) this.showNotice(this.t('settingssaved'));
      else if (Number.isFinite(actionTime)) {
        if (message.type === 'focus_schedule_skip') {
          this.announcements.announce(this.t('focus_schedule_skipped', formatTime(actionTime)));
        } else if (message.type === 'focus_schedule_restore') {
          this.announcements.announce(this.t('focus_schedule_restored', formatTime(actionTime)));
        }
      }
    } catch (error) {
      if (!fill && error?.code === 'schedule_changed') {
        this.showNotice(this.t('focus_schedule_action_changed'));
        refresh = true;
      } else this.showError(error);
    } finally {
      this.setBusy(false);
      doc?.removeEventListener('focusin', changedFocus);
      doc?.removeEventListener('pointerdown', changedFocus);
      if (refresh) await this.refresh();
      if (returnFocus && this.restore.hidden && !this.skip.hidden && !this.skip.disabled &&
          !doc.hidden && !doc.querySelector('dialog[open]')) this.skip.focus();
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
    // Reset the initial disclosure state before handling an explicit deep link.
    if (root?.tagName === 'DETAILS') root.open = false;
    const reveal = () => revealFocusSchedule(root, window.location.hash);
    reveal();
    window.addEventListener('hashchange', reveal);
    void mountFocusSchedule(root, chrome.storage);
  });
}
