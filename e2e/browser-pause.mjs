import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The watchdog owns the signals and cleanup independently of the test runner.
// It validates ancestry + exact profile, and pins all recipients with pidfds.
export async function pauseOwnedBrowser({ pid, profile, milliseconds, onStopped }) {
  const child = spawn('python3', [fileURLToPath(new URL('./pause-owned-browser.py', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', progress = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk; progress += chunk;
    let end;
    while ((end = progress.indexOf('\n')) >= 0) {
      const line = progress.slice(0,end); progress = progress.slice(end+1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === 'fully-stopped') onStopped?.(event);
    }
  });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      try {
        const report = JSON.parse(stdout);
        if (code !== 0 || report.status !== 'passed') {
          throw Object.assign(new Error(report.error || `Watchdog exited: ${code}/${signal}: ${stderr}`), { report });
        }
        resolve(report);
      } catch (error) { reject(error); }
    });
  });
  child.stdin.on('error', () => {}); // Spawn errors are reported through result.
  child.stdin.end(JSON.stringify({ pid, profile, milliseconds, parent: process.pid }));
  return result;
}
