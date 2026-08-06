import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticsUI } from '../options/diagnosticsUI.js';

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.disabled = false;
    this.textContent = '';
    this.value = '';
    this.clicked = false;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async dispatch(type) { return this.listeners.get(type)?.({ target: this }); }
  setAttribute() {}
  select() {}
  click() { this.clicked = true; }
  remove() {}
}

function createHarness() {
  const previousChrome = globalThis.browser;
  globalThis.browser = {
    i18n: {
      getMessage(key) { return key; }
    }
  };

  const elements = {
    generateButton: new FakeElement(),
    copyButton: new FakeElement(),
    exportButton: new FakeElement(),
    clearButton: new FakeElement(),
    output: new FakeElement(),
    status: new FakeElement()
  };
  elements.output.classList.add('hidden');
  elements.status.classList.add('hidden');

  const copied = [];
  const anchors = [];
  const body = {
    appendChild(element) { anchors.push(element); }
  };
  const documentRef = {
    body,
    createElement() { return new FakeElement(); },
    execCommand() { return true; }
  };
  const generatedReport = {
    generatedAt: '2026-08-06T20:00:00.000Z',
    extension: { version: '4.7.0', manifestVersion: 3 },
    browser: { name: 'Chrome', version: '140', platform: 'Android' },
    access: { isPro: true, isLegacyUser: false },
    settings: { debugMode: true, mode: 'normal', disabledCategories: [] },
    rules: { total: 1, blacklist: 1, whitelist: 0, scheduled: 0, disabledByUser: 0 },
    dnr: { currentCount: 1, expectedCount: 1, inSync: true },
    permissions: { hostAccess: true },
    focusSession: { active: false, mode: 'blacklist', hardcore: false, remainingMinutes: 0 },
    license: { lastCheck: null },
    recentEvents: []
  };
  let clearCalls = 0;
  let revokedUrl = null;

  const ui = new DiagnosticsUI({
    ...elements,
    onGenerate: async () => generatedReport,
    onClear: async () => { clearCalls++; },
    clipboard: { async writeText(value) { copied.push(value); } },
    documentRef,
    urlApi: {
      createObjectURL() { return 'blob:test'; },
      revokeObjectURL(value) { revokedUrl = value; }
    },
    BlobCtor: class FakeBlob {},
    confirmFn: () => true
  });
  ui.initialize();

  return {
    ui,
    elements,
    copied,
    anchors,
    getClearCalls: () => clearCalls,
    getRevokedUrl: () => revokedUrl,
    restore() { globalThis.browser = previousChrome; }
  };
}

test('diagnostics UI generates and copies a readable report', async () => {
  const harness = createHarness();
  try {
    await harness.ui.generate();
    assert.match(harness.elements.output.textContent, /BlockDistraction Diagnostic Report/);
    assert.equal(harness.elements.output.classList.contains('hidden'), false);
    assert.equal(harness.elements.copyButton.disabled, false);

    await harness.ui.copy();
    assert.equal(harness.copied.length, 1);
    assert.match(harness.copied[0], /Stored rules: 1/);
  } finally {
    harness.restore();
  }
});

test('diagnostics UI exports JSON and clears event history', async () => {
  const harness = createHarness();
  try {
    await harness.ui.generate();
    assert.equal(await harness.ui.exportJson(), true);
    assert.equal(harness.anchors.length, 1);
    assert.equal(harness.anchors[0].download.startsWith('blockdistraction-diagnostics-'), true);
    assert.equal(harness.getRevokedUrl(), 'blob:test');

    assert.equal(await harness.ui.clearHistory(), true);
    assert.equal(harness.getClearCalls(), 1);
    assert.equal(harness.elements.output.textContent, 'diagnosticsempty');
  } finally {
    harness.restore();
  }
});


test('diagnostics UI preserves the native confirm invocation context', async () => {
  const previousConfirm = globalThis.confirm;
  const previousChrome = globalThis.browser;
  let confirmCalls = 0;
  globalThis.confirm = function () {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    confirmCalls++;
    return true;
  };
  globalThis.browser = {
    i18n: { getMessage(key) { return key; } }
  };

  const output = new FakeElement();
  const status = new FakeElement();
  const ui = new DiagnosticsUI({
    generateButton: new FakeElement(),
    copyButton: new FakeElement(),
    exportButton: new FakeElement(),
    clearButton: new FakeElement(),
    output,
    status,
    onGenerate: async () => ({}),
    onClear: async () => true
  });

  try {
    ui.initialize();
    assert.equal(await ui.clearHistory(), true);
    assert.equal(confirmCalls, 1);
  } finally {
    globalThis.confirm = previousConfirm;
    globalThis.browser = previousChrome;
  }
});
