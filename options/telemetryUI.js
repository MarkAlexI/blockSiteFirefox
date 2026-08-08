function message(key) {
  return browser.i18n.getMessage(key) || key;
}

export class TelemetryUI {
  constructor({
    checkbox,
    status,
    onGetConsent,
    onSetConsent
  }) {
    this.checkbox = checkbox;
    this.status = status;
    this.onGetConsent = onGetConsent;
    this.onSetConsent = onSetConsent;
    this.isUpdating = false;
  }

  async initialize() {
    if (!this.checkbox) return;
    this.checkbox.disabled = true;
    try {
      const consent = await this.onGetConsent();
      this.checkbox.checked = consent?.enabled === true;
    } catch {
      this.showStatus(message('telemetryerror'), 'error');
    } finally {
      this.checkbox.disabled = false;
    }

    this.checkbox.addEventListener('change', () => this.handleChange());
  }

  showStatus(text, type = 'success') {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.remove('hidden', 'success', 'error');
    this.status.classList.add(type);
  }

  async handleChange() {
    if (this.isUpdating) return false;
    const requested = this.checkbox.checked === true;
    this.isUpdating = true;
    this.checkbox.disabled = true;

    try {
      const consent = await this.onSetConsent(requested);
      this.checkbox.checked = consent?.enabled === true;
      this.showStatus(this.checkbox.checked ?
        message('telemetryenabled') : message('telemetrydisabled'));
      return true;
    } catch {
      this.checkbox.checked = !requested;
      this.showStatus(message('telemetryerror'), 'error');
      return false;
    } finally {
      this.checkbox.disabled = false;
      this.isUpdating = false;
    }
  }
}
