import test from 'node:test';
import assert from 'node:assert/strict';
import { activateNativeWindow } from '../e2e/native-window-focus.mjs';

function desktop({ clients = ['0x100'], owners = {}, before = '0x200', after = '0x100',
  changesAt = 0, activationError = null } = {}) {
  const calls = []; let activeReads = 0, ownedReads = 0;
  const run = async (file, args, options) => {
    calls.push({ file, args }); assert.equal(options.timeout, 3000);
    if (file === 'xdotool') {
      if (activationError) throw activationError;
      return { stdout: '' };
    }
    if (args[1] === '_NET_CLIENT_LIST') return { stdout: `_NET_CLIENT_LIST(WINDOW): window id # ${clients.join(', ')}\n` };
    if (args[1] === '_NET_ACTIVE_WINDOW') return { stdout: `_NET_ACTIVE_WINDOW(WINDOW): window id # ${++activeReads === 1 ? before : after}\n` };
    const id = args[1], owner = owners[id] || { pid: 123, type: 'NORMAL' };
    if (id === '0x100' && changesAt && ++ownedReads >= changesAt) return { stdout: '_NET_WM_PID(CARDINAL) = 999\n' };
    return { stdout: `_NET_WM_PID(CARDINAL) = ${owner.pid}\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_${owner.type}\n` };
  };
  return { calls, options: { platform: 'linux', env: { DISPLAY: ':45' }, run } };
}
const activations = model => model.calls.filter(call => call.file === 'xdotool');

for (const before of ['0x200', '0x100']) test(`one EWMH activation verifies the owned Firefox client (previous ${before})`, async () => {
  const model = desktop({ before });
  const result = await activateNativeWindow({ processId: 123 }, model.options);
  assert.equal(result.before, BigInt(before).toString());
  assert.equal(result.after, '256'); assert.equal(result.processId, 123);
  assert.equal(result.backend, 'X11/EWMH');
  assert.deepEqual(activations(model), [{ file: 'xdotool', args: ['windowactivate', '--sync', '0x100'] }]);
});

test('a foreign window and the owned popup cannot become the activation target', async () => {
  const model = desktop({ clients: ['0x200', '0x300', '0x100'], owners: {
    '0x200': { pid: 999, type: 'NORMAL' }, '0x300': { pid: 123, type: 'POPUP_MENU' }
  } });
  await activateNativeWindow({ processId: 123 }, model.options);
  assert.deepEqual(activations(model)[0].args, ['windowactivate', '--sync', '0x100']);
});

test('missing or ambiguous owned browser clients fail before any native action', async () => {
  for (const input of [{ clients: [] }, { clients: ['0x100', '0x101'] },
    { owners: { '0x100': { pid: 999, type: 'NORMAL' } } }]) {
    const model = desktop(input);
    await assert.rejects(activateNativeWindow({ processId: 123 }, model.options), /one owned Firefox window/);
    assert.deepEqual(activations(model), []);
  }
});

test('changed client ownership fails before activation', async () => {
  const model = desktop({ changesAt: 2 });
  await assert.rejects(activateNativeWindow({ processId: 123 }, model.options), /ownership changed/);
  assert.deepEqual(activations(model), []);
});

test('an unsuccessful or replaced activation is reported without a retry', async () => {
  for (const input of [{ after: '0x200' }, { changesAt: 3 }]) {
    const model = desktop(input);
    await assert.rejects(activateNativeWindow({ processId: 123 }, model.options), /was not activated/);
    assert.equal(activations(model).length, 1);
  }
});

test('an activation command failure propagates without another native action', async () => {
  const error = new Error('window manager rejected activation'), model = desktop({ activationError: error });
  await assert.rejects(activateNativeWindow({ processId: 123 }, model.options), value => value === error);
  assert.equal(activations(model).length, 1);
});

test('an unreadable desktop focus state is not accepted as successful activation', async () => {
  for (const [input, delivered] of [[{ before: 'unknown' }, 0], [{ after: 'unknown' }, 1]]) {
    const model = desktop(input);
    await assert.rejects(activateNativeWindow({ processId: 123 }, model.options), /Cannot read native active window/);
    assert.equal(activations(model).length, delivered);
  }
});

test('unsupported desktops and invalid process IDs fail before executing commands', async () => {
  for (const options of [{ platform: 'win32' }, { env: {} }]) {
    const model = desktop();
    await assert.rejects(activateNativeWindow({ processId: 123 }, { ...model.options, ...options }), /Linux\/X11/);
    assert.deepEqual(model.calls, []);
  }
  for (const processId of [undefined, null, '123', 0, -1, NaN, 2 ** 53]) {
    const model = desktop();
    await assert.rejects(activateNativeWindow({ processId }, model.options), /process ID/);
    assert.deepEqual(model.calls, []);
  }
});
