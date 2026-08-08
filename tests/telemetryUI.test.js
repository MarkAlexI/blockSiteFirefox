import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryUI } from '../options/telemetryUI.js';

class FakeClassList {
  constructor() { this.values = new Set(['hidden']); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor() {
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.classList = new FakeClassList();
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async dispatch(type) { return this.listeners.get(type)?.({ target: this }); }
}

function withBrowser(run) {
  const previous = globalThis.browser;
  globalThis.browser = { i18n: { getMessage: key => key } };
  return Promise.resolve(run()).finally(() => { globalThis.browser = previous; });
}

test('telemetry UI loads opt-in state and updates explicit consent', async () => withBrowser(async () => {
  const checkbox = new FakeElement();
  const status = new FakeElement();
  const changes = [];
  const ui = new TelemetryUI({
    checkbox,
    status,
    onGetConsent: async () => ({ enabled: false }),
    onSetConsent: async enabled => {
      changes.push(enabled);
      return { enabled };
    }
  });

  await ui.initialize();
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  await ui.handleChange();
  assert.deepEqual(changes, [true]);
  assert.equal(checkbox.checked, true);
  assert.equal(status.textContent, 'telemetryenabled');
}));

test('telemetry UI restores the previous choice when consent update fails', async () => withBrowser(async () => {
  const checkbox = new FakeElement();
  const status = new FakeElement();
  const ui = new TelemetryUI({
    checkbox,
    status,
    onGetConsent: async () => ({ enabled: false }),
    onSetConsent: async () => { throw new Error('failed'); }
  });

  await ui.initialize();
  checkbox.checked = true;
  assert.equal(await ui.handleChange(), false);
  assert.equal(checkbox.checked, false);
  assert.equal(status.textContent, 'telemetryerror');
  assert.equal(status.classList.contains('error'), true);
}));
