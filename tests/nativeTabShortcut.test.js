import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeTabShortcut, nativeTabShortcutBackend } from '../e2e/native-tab-shortcut.mjs';

function commands({ title = 'BD E2E restore-owned - Browser', lastActive = '123', extensions = 'XTEST' } = {}) {
  const calls = []; let activeReads = 0;
  const run = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'version') return { stdout: 'xdotool version native-fixture' };
    if (file === 'xdpyinfo') return { stdout: extensions };
    if (args[0] === 'getactivewindow') return { stdout: ++activeReads === 1 ? '123' : lastActive };
    if (args[0] === 'getwindowname') return { stdout: title };
    return { stdout: '' };
  };
  return { calls, options: { platform: 'linux', env: { DISPLAY: ':45' }, run } };
}

test('native restore shortcut delivers exactly once through focused XTEST input', async () => {
  const model = commands();
  const value = await nativeTabShortcut({ action: 'restore', expectedTitle: 'BD E2E restore-owned' }, model.options);
  assert.equal(value.active, '123'); assert.equal(value.delivery, 'XTEST');
  assert.deepEqual(model.calls, [
    { file: 'xdotool', args: ['getactivewindow'] },
    { file: 'xdotool', args: ['getwindowname', '123'] },
    { file: 'xdotool', args: ['getactivewindow'] },
    { file: 'xdotool', args: ['key', '--clearmodifiers', 'ctrl+shift+t'] }
  ]);
});

test('native shortcut never sends a key to a different fixture title or changed desktop focus', async () => {
  for (const input of [{ title: 'unrelated window' }, { lastActive: '456' }]) {
    const model = commands(input);
    await assert.rejects(nativeTabShortcut({ action: 'close', expectedTitle: 'BD E2E restore-owned' }, model.options), /target mismatch|focus changed/);
    assert.equal(model.calls.some(call => call.args[0] === 'key'), false);
  }
});

test('native shortcut backend rejects missing XTEST before a scenario can run', async () => {
  const model = commands({ extensions: 'OTHER' });
  await assert.rejects(nativeTabShortcutBackend(model.options), /XTEST/);
  assert.equal(model.calls.some(call => call.args[0] === 'key'), false);
});

test('native shortcut backend rejects non-X11 platforms before running commands', async () => {
  for (const input of [{ platform: 'win32', env: {} }, { platform: 'linux', env: {} }]) {
    const model = commands();
    await assert.rejects(nativeTabShortcutBackend({ ...model.options, ...input }), /Linux\/X11/);
    assert.deepEqual(model.calls, []);
  }
});
