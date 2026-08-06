import { formatDiagnosticReportText } from '../diagnostics/diagnosticReport.js';

function message(key, substitutions) {
  return browser.i18n.getMessage(key, substitutions) || key;
}

export class DiagnosticsUI {
  constructor({
    generateButton,
    copyButton,
    exportButton,
    clearButton,
    output,
    status,
    onGenerate,
    onClear,
    clipboard = globalThis.navigator?.clipboard,
    documentRef = globalThis.document,
    urlApi = globalThis.URL,
    BlobCtor = globalThis.Blob,
    confirmFn = typeof globalThis.confirm === 'function' ? globalThis.confirm.bind(globalThis) : null
  }) {
    this.generateButton = generateButton;
    this.copyButton = copyButton;
    this.exportButton = exportButton;
    this.clearButton = clearButton;
    this.output = output;
    this.status = status;
    this.onGenerate = onGenerate;
    this.onClear = onClear;
    this.clipboard = clipboard;
    this.documentRef = documentRef;
    this.urlApi = urlApi;
    this.BlobCtor = BlobCtor;
    this.confirmFn = confirmFn;
    this.report = null;
    this.reportText = '';
  }

  initialize() {
    if (!this.generateButton) return;
    this.copyButton.disabled = true;
    this.exportButton.disabled = true;

    this.generateButton.addEventListener('click', () => this.generate());
    this.copyButton.addEventListener('click', () => this.copy());
    this.exportButton.addEventListener('click', () => this.exportJson());
    this.clearButton.addEventListener('click', () => this.clearHistory());
  }

  setBusy(busy) {
    for (const button of [this.generateButton, this.copyButton, this.exportButton, this.clearButton]) {
      if (button) button.disabled = busy || (!this.report && (button === this.copyButton || button === this.exportButton));
    }
  }

  showStatus(text, type = 'success') {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.remove('hidden', 'success', 'error');
    this.status.classList.add(type);
  }

  async generate() {
    this.setBusy(true);
    try {
      this.report = await this.onGenerate();
      this.reportText = formatDiagnosticReportText(this.report);
      this.output.textContent = this.reportText;
      this.output.classList.remove('hidden');
      this.showStatus(message('diagnosticsgenerated'));
      return this.report;
    } catch (error) {
      this.showStatus(`${message('diagnosticserror')}: ${error.message}`, 'error');
      return null;
    } finally {
      this.setBusy(false);
    }
  }

  async copy() {
    if (!this.reportText && !await this.generate()) return false;

    try {
      if (this.clipboard?.writeText) {
        await this.clipboard.writeText(this.reportText);
      } else {
        const textarea = this.documentRef.createElement('textarea');
        textarea.value = this.reportText;
        textarea.setAttribute('readonly', '');
        this.documentRef.body.appendChild(textarea);
        textarea.select();
        this.documentRef.execCommand('copy');
        textarea.remove();
      }
      this.showStatus(message('diagnosticscopied'));
      return true;
    } catch (error) {
      this.showStatus(`${message('diagnosticserror')}: ${error.message}`, 'error');
      return false;
    }
  }

  async exportJson() {
    if (!this.report && !await this.generate()) return false;

    try {
      const blob = new this.BlobCtor([JSON.stringify(this.report, null, 2)], {
        type: 'application/json'
      });
      const url = this.urlApi.createObjectURL(blob);
      const anchor = this.documentRef.createElement('a');
      anchor.href = url;
      anchor.download = `blockdistraction-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      this.documentRef.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      this.urlApi.revokeObjectURL(url);
      this.showStatus(message('diagnosticsexported'));
      return true;
    } catch (error) {
      this.showStatus(`${message('diagnosticserror')}: ${error.message}`, 'error');
      return false;
    }
  }

  async clearHistory() {
    const confirmClear = this.confirmFn;
    if (confirmClear && !confirmClear(message('diagnosticsconfirmclear'))) return false;

    this.setBusy(true);
    try {
      await this.onClear();
      this.report = null;
      this.reportText = '';
      this.output.textContent = message('diagnosticsempty');
      this.output.classList.remove('hidden');
      this.showStatus(message('diagnosticscleared'));
      return true;
    } catch (error) {
      this.showStatus(`${message('diagnosticserror')}: ${error.message}`, 'error');
      return false;
    } finally {
      this.setBusy(false);
    }
  }
}
