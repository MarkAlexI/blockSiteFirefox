import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pauseOwnedBrowser } from '../e2e/browser-pause.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(run) {
  const profile = await mkdtemp(path.join(tmpdir(), 'bd-pause-control-'));
  const script = `const fs=require('fs'); const {spawn}=require('child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
    let sequence=0;const target=${JSON.stringify(path.join(profile, 'heartbeat.json'))};
    setInterval(()=>{fs.writeFileSync(target+'.tmp',JSON.stringify({sequence:++sequence,child:child.pid}));fs.renameSync(target+'.tmp',target)},10);
    process.on('SIGTERM',()=>{child.kill();process.exit()});`;
  const browser = spawn(process.execPath, ['-e', script, '--', '--profile', profile], { stdio: 'ignore' });
  const exited = new Promise(resolve => browser.once('exit', resolve));
  const heartbeat = async () => JSON.parse(await readFile(path.join(profile, 'heartbeat.json'), 'utf8'));
  try {
    for (let i=0;;i++) {
      try { await heartbeat(); break; }
      catch (error) { if (i===100) throw error; await sleep(10); }
    }
    await run({ pid: browser.pid, profile, heartbeat });
  } finally {
    browser.kill('SIGCONT'); browser.kill('SIGTERM');
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
}

test('native pause watchdog stops both the owned parent and its descendant, then resumes them', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ pid, profile, heartbeat }) => {
    const before = await heartbeat();
    const result = await pauseOwnedBrowser({ pid, profile, milliseconds: 300 });
    assert.equal(result.deviceSleep, false);
    assert.ok(result.heldMs >= 300);
    assert.ok(result.stopped.some(item => item.pid === pid));
    assert.ok(result.stopped.some(item => item.pid === before.child));
    assert.ok(result.stopped.every(item => item.state === 'T'));
    assert.deepEqual(result.afterHold, result.stopped);
    assert.deepEqual([...result.resumed].sort((a,b)=>a-b), result.stopped.map(p=>p.pid).sort((a,b)=>a-b));
    await sleep(40);
    assert.ok((await heartbeat()).sequence > before.sequence, 'real heartbeat resumes');
  });
});

test('native pause rejects a profile mismatch before sending any signal', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ pid, profile, heartbeat }) => {
    const before = await heartbeat();
    await assert.rejects(pauseOwnedBrowser({ pid, profile: path.dirname(profile), milliseconds: 300 }), /does not own/);
    await sleep(40);
    assert.ok((await heartbeat()).sequence > before.sequence);
  });
});

test('native pause rejects the test runner itself', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ profile }) => {
    await assert.rejects(pauseOwnedBrowser({ pid: process.pid, profile, milliseconds: 300 }), /Invalid fixture/);
  });
});

test('native pause rejects unbounded and malformed durations without stopping the child', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ pid, profile, heartbeat }) => {
    for (const milliseconds of [0, 180001, 300.5, '300']) {
      await assert.rejects(pauseOwnedBrowser({ pid, profile, milliseconds }), /duration/);
    }
    const before = await heartbeat();
    await sleep(40);
    assert.ok((await heartbeat()).sequence > before.sequence);
  });
});

test('an interrupted stop fails the proof and still resumes every pinned process', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ pid, profile, heartbeat }) => {
    let stopped;
    const entered = new Promise(resolve => { stopped = resolve; });
    const pending = pauseOwnedBrowser({ pid, profile, milliseconds: 1000, onStopped: stopped });
    // Attach rejection handling before this deliberately broken interleaving.
    const result = pending.then(value => ({ value }), error => ({ error }));
    await Promise.race([entered, pending.then(() => { throw new Error('Pause completed before its stop receipt'); })]);
    process.kill(pid, 'SIGCONT');
    const { error } = await result;
    assert.match(error?.message || '', /ran or changed identity/);
    assert.equal(error.report.status, 'failed');
    assert.ok(error.report.resumed.includes(pid));
    const before = await heartbeat();
    await sleep(40);
    assert.ok((await heartbeat()).sequence > before.sequence);
  });
});
