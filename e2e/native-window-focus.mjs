import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function activeWindow(text) {
  const id = text.match(/^_NET_ACTIVE_WINDOW\(WINDOW\): window id # (0x[\da-f]+)\s*$/im)?.[1];
  if (!id) throw new Error(`Cannot read native active window: ${text.trim()}`);
  return BigInt(id).toString();
}

function ownedNormalWindow(text, processId) {
  return Number(text.match(/^_NET_WM_PID\(CARDINAL\) = (\d+)\s*$/m)?.[1]) === processId &&
    /^_NET_WM_WINDOW_TYPE\(ATOM\) = _NET_WM_WINDOW_TYPE_NORMAL\s*$/m.test(text);
}

// WebDriver can click an element without activating its OS window. This is
// one real EWMH activation of the owned Firefox client, not a DOM focus shim.
export async function activateNativeWindow({ processId }, {
  platform = process.platform, env = process.env, run = execute
} = {}) {
  if (platform !== 'linux' || !env.DISPLAY) throw new Error('Native window activation requires Linux/X11 DISPLAY');
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('A native Firefox process ID is required');
  const options = { env, timeout: 3000 };
  const read = async args => (await run('xprop', args, options)).stdout;
  const clients = await read(['-root', '_NET_CLIENT_LIST']);
  const ids = [...new Set(clients.match(/0x[\da-f]+/gi) || [])].filter(id => BigInt(id) > 0n);
  const matches = [];
  const properties = id => read(['-id', id, '_NET_WM_PID', '_NET_WM_WINDOW_TYPE']);
  for (const id of ids) if (ownedNormalWindow(await properties(id), processId)) matches.push(id);
  if (matches.length !== 1) throw new Error(`Expected one owned Firefox window: ${JSON.stringify({ processId, matches, clients: clients.trim() })}`);
  const windowId = matches[0];
  const before = activeWindow(await read(['-root', '_NET_ACTIVE_WINDOW']));
  // A closed/replaced client must fail before any activation is delivered.
  if (!ownedNormalWindow(await properties(windowId), processId)) throw new Error('Native Firefox window ownership changed before activation');
  await run('xdotool', ['windowactivate', '--sync', windowId], options);
  const after = activeWindow(await read(['-root', '_NET_ACTIVE_WINDOW']));
  const evidence = { backend: 'X11/EWMH', processId, windowId, before, after };
  if (after !== BigInt(windowId).toString() || !ownedNormalWindow(await properties(windowId), processId)) {
    throw new Error(`Native Firefox window was not activated: ${JSON.stringify(evidence)}`);
  }
  return evidence;
}
