import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { focusOptionsForImport } from '../e2e/popup-probes.mjs';

function host({ trusted = true, focused = true, visibility = 'visible', active = 'search-input', clickError = null, activationError = null } = {}) {
  const events = [], window = {}, listeners = new Map();
  const input = { id: 'search-input', value: 'keep-this-draft',
    addEventListener(type, listener) { listeners.set(type, listener); } };
  const document = { visibilityState: 'visible', activeElement: { id: '__bdOpenToolbar' },
    hasFocus: () => false, getElementById: id => id === 'search-input' ? input : null };
  return { events, input,
    async evaluate(fn) {
      const value = vm.runInNewContext(`(${fn})()`, { window, document });
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    },
    async front(options) {
      assert.deepEqual(options, { reselect: true });
      events.push('front');
    },
    async activateNativeWindow() {
      events.push('desktop');
      if (activationError) throw activationError;
      return { backend: 'X11/EWMH', processId: 123, windowId: '0x100', before: '512', after: '256' };
    },
    async clickUnsettled(selector) {
      assert.equal(selector, '#search-input'); events.push('pointer');
      if (clickError) throw clickError;
      document.visibilityState = visibility;
      document.hasFocus = () => focused;
      document.activeElement = active === input.id ? input : { id: active };
      listeners.get('pointerdown')?.({ isTrusted: trusted, pointerType: 'mouse' });
    }
  };
}

test('toolbar import restores content focus with one pointer action and retains the Search draft', async () => {
  const page = host();
  const result = await focusOptionsForImport(page);
  assert.deepEqual(page.events, ['front', 'desktop', 'pointer']);
  assert.equal(result.desktop.after, '256');
  assert.equal(result.before.focused, false);
  assert.equal(result.after.focused, true);
  assert.equal(result.after.active, 'search-input');
  assert.equal(result.after.pointer.trusted, true);
  assert.equal(result.after.draft, 'keep-this-draft');
  assert.equal(page.input.value, 'keep-this-draft');
});

for (const [options, error] of [
  [{ trusted: false }, /native pointer input/],
  [{ focused: false }, /content focus/],
  [{ visibility: 'hidden' }, /visible document/],
  [{ active: 'another-control' }, /focus target changed/]
]) test(`toolbar import rejects an unready context: ${Object.keys(options)[0]}`, async () => {
  const page = host(options);
  await assert.rejects(focusOptionsForImport(page), error);
  assert.deepEqual(page.events, ['front', 'desktop', 'pointer']);
});

test('a failed pointer action is reported without a retry or programmatic focus fallback', async () => {
  const failure = new Error('native pointer unavailable'), page = host({ clickError: failure });
  await assert.rejects(focusOptionsForImport(page), error => error === failure);
  assert.deepEqual(page.events, ['front', 'desktop', 'pointer']);
});

test('a failed desktop activation prevents the file-selection pointer action', async () => {
  const failure = new Error('native activation unavailable'), page = host({ activationError: failure });
  await assert.rejects(focusOptionsForImport(page), error => error === failure);
  assert.deepEqual(page.events, ['front', 'desktop']);
});

test('focus evidence survives a rejected content-focus precondition', async () => {
  const page = host({ focused: false }), records = [];
  await assert.rejects(focusOptionsForImport(page, value => records.push(value)), /content focus/);
  assert.equal(records.length, 1);
  assert.equal(records[0].desktop.backend, 'X11/EWMH');
  assert.equal(records[0].after.focused, false);
  assert.deepEqual(page.events, ['front', 'desktop', 'pointer']);
});
