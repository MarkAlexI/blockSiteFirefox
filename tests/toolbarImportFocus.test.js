import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { focusOptionsForImport } from '../e2e/popup-probes.mjs';

function host({ trusted = true, focused = true, visibility = 'visible', active = 'search-input', clickError = null } = {}) {
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
    async front() { events.push('front'); },
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
  assert.deepEqual(page.events, ['front', 'pointer']);
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
  assert.deepEqual(page.events, ['front', 'pointer']);
});

test('a failed pointer action is reported without a retry or programmatic focus fallback', async () => {
  const failure = new Error('native pointer unavailable'), page = host({ clickError: failure });
  await assert.rejects(focusOptionsForImport(page), error => error === failure);
  assert.deepEqual(page.events, ['front', 'pointer']);
});
