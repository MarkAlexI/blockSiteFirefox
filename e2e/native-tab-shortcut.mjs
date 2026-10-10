import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const shortcuts = { close: 'ctrl+w', restore: 'ctrl+shift+t' };

function requireX11(platform, env) {
  if (platform !== 'linux' || !env.DISPLAY) {
    throw new Error('Native tab shortcuts require Linux/X11 DISPLAY; run this scenario in Linux CI');
  }
}

// Check before launch/body so a missing native backend is a setup blocker.
export async function nativeTabShortcutBackend({ platform = process.platform, env = process.env, run = execute } = {}) {
  requireX11(platform, env);
  const options = { timeout: 3000, env };
  const version = await run('xdotool', ['version'], options);
  const extensions = await run('xdpyinfo', ['-queryExtensions'], options);
  if (!/\bXTEST\b/.test(extensions.stdout)) throw new Error('Native tab shortcuts require the XTEST extension');
  return { platform, display: env.DISPLAY, xdotool: version.stdout.trim(), xtest: true };
}

export async function nativeTabWindow({ platform = process.platform, env = process.env, run = execute } = {}) {
  requireX11(platform, env);
  const options = { timeout: 3000, env };
  const active = (await run('xdotool', ['getactivewindow'], options)).stdout.trim();
  if (!/^\d+$/.test(active)) throw new Error('No native active browser window');
  const title = (await run('xdotool', ['getwindowname', active], options)).stdout.trim();
  return { active, title };
}

// Send one accelerator to the real focused desktop. No --window (XSendEvent),
// CDP keyboard emulation, sessions permission, API wrapper or retry.
export async function nativeTabShortcut({ action, expectedTitle }, { platform = process.platform, env = process.env, run = execute } = {}) {
  requireX11(platform, env);
  if (!Object.hasOwn(shortcuts, action)) throw new Error('Unknown native tab shortcut');
  if (typeof expectedTitle !== 'string' || !expectedTitle.trim()) throw new Error('A fixture-specific native title is required');
  const options = { timeout: 3000, env };
  const { active, title } = await nativeTabWindow({ platform, env, run });
  if (!title.includes(expectedTitle)) throw new Error(`Native shortcut target mismatch: ${JSON.stringify({ active, title, expectedTitle })}`);
  const checked = (await run('xdotool', ['getactivewindow'], options)).stdout.trim();
  if (checked !== active) throw new Error('Native shortcut focus changed before delivery');
  const sentAt = Date.now();
  await run('xdotool', ['key', '--clearmodifiers', shortcuts[action]], options);
  return { action, shortcut: shortcuts[action], active, title, expectedTitle, sentAt, completedAt: Date.now(), delivery: 'XTEST' };
}
