import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const noop = async () => {};

// Linux/Xvfb native windows and action panels needs normal desktop window/focus handling.
// The runner calls this for native desktop scenarios, before launch.
export async function startNativeWindowManager(output) {
  if (process.platform !== 'linux' || (!process.env.DISPLAY && process.env.WAYLAND_DISPLAY)) {
    return { evidence: { source: 'system desktop' }, close: noop };
  }
  if (!process.env.DISPLAY) throw new Error('Native desktop setup requires DISPLAY (use xvfb-run)');
  const read = async () => {
    const { stdout } = await execute('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { timeout: 1000 });
    return /window id # 0x0*[1-9a-fA-F][0-9a-fA-F]*/.test(stdout) ? stdout.trim() : null;
  };
  const existing = await read();
  if (existing) return { evidence: { source: 'existing window manager', property: existing }, close: noop };

  await mkdir(output, { recursive: true });
  const log = await open(path.join(output, 'window-manager.log'), 'w');
  let wm, exited, finished = false, spawnError = null;
  try {
    wm = spawn('openbox', ['--sm-disable'], { stdio: ['ignore', log.fd, log.fd] });
    exited = new Promise(resolve => {
      wm.once('exit', () => { finished = true; resolve(); });
      wm.once('error', error => { spawnError = error; finished = true; resolve(); });
    });
  } finally { await log.close(); }
  const close = async () => {
    if (finished) return;
    wm.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([exited, new Promise(resolve => {
        timer = setTimeout(() => { if (!finished) wm.kill('SIGKILL'); resolve(); }, 5000);
      })]);
      await exited;
    } finally { clearTimeout(timer); }
  };
  try {
    const deadline = Date.now() + 5000;
    let property;
    do {
      if (spawnError) throw spawnError;
      if (finished) throw new Error(`Openbox exited during native desktop setup (${wm.exitCode}); see window-manager.log`);
      property = await read();
      if (property) break;
      await wait(50);
    } while (Date.now() < deadline);
    if (!property) throw new Error('Window manager did not become ready within 5 seconds');
    return { evidence: { source: 'Openbox', processId: wm.pid, property }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
