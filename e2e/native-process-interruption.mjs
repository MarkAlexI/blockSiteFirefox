import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function readProcess(pid) {
  try {
    const [cmdline, stat] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')
    ]);
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    return { args: cmdline.split('\0').filter(Boolean), state: fields[0], started: fields[19] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}

// The PID must come from this harness's native launch / WebDriver session.
// Match the exact isolated profile twice before signaling; never use pkill,
// killall, process-name matching or an unverified stale PID.
export async function interruptProfileBrowser({ pid, profile }, {
  platform = process.platform, read = readProcess, signal = (id, value) => process.kill(id, value),
  now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 5000
} = {}) {
  assert.equal(platform, 'linux', 'native interruption requires Linux /proc');
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid, 'owned browser PID');
  assert.ok(typeof profile === 'string' && path.isAbsolute(profile), 'absolute isolated profile');
  const belongs = record => record?.args?.some((arg, index, args) =>
    arg === `--user-data-dir=${profile}` ||
    (['-profile', '--profile'].includes(arg) && args[index + 1] === profile));
  const before = await read(pid);
  assert.ok(belongs(before) && before.started && !['Z', 'X'].includes(before.state), 'live browser owns the exact profile');
  const checked = await read(pid);
  assert.ok(belongs(checked) && checked.started === before.started && !['Z', 'X'].includes(checked.state),
    'browser identity is unchanged immediately before interruption');
  const signaledAt = now();
  assert.notEqual(signal(pid, 'SIGKILL'), false, 'native SIGKILL was accepted');
  const deadline = signaledAt + timeout;
  for (;;) {
    const after = await read(pid);
    if (!after || after.started !== before.started || ['Z', 'X'].includes(after.state)) {
      return { pid, profile, signal: 'SIGKILL', processStarted: before.started,
        signaledAt, exitedAt: now(), finalState: after?.state ?? 'absent' };
    }
    assert.ok(now() < deadline, 'interrupted browser process exited within the cleanup budget');
    await pause(25);
  }
}
