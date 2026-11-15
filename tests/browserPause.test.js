import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pauseOwnedBrowser } from '../e2e/browser-pause.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(run, {
  startupDelayMs = 0, startupTimeoutMs = 10000, executable = process.execPath, script
} = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), 'bd-pause-control-'));
  const source = script ?? `const fs=require('fs'); const {spawn}=require('child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    let sequence=0;const target=${JSON.stringify(path.join(profile, 'heartbeat.json'))};
    let startup,timer,stopping=false;
    const stop=(code=0)=>{
      if(stopping)return;stopping=true;clearTimeout(startup);clearInterval(timer);
      if(child.exitCode!==null||child.signalCode!==null){process.exit(code);return;}
      child.once('close',()=>process.exit(code));child.kill('SIGCONT');child.kill('SIGTERM');
    };
    process.on('SIGTERM',()=>stop());process.on('disconnect',()=>stop());
    child.on('error',error=>{console.error(error);stop(1)});
    const beat=()=>{
      fs.writeFileSync(target+'.tmp',JSON.stringify({sequence:++sequence,child:child.pid}));
      fs.renameSync(target+'.tmp',target);
    };
    child.once('spawn',()=>{startup=setTimeout(()=>{
      try {beat();process.send('ready');timer=setInterval(beat,10);}
      catch(error){console.error(error);stop(1)}
    },${startupDelayMs})});`;
  const browser = spawn(executable, ['-e', source, '--', '--profile', profile],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', spawnError;
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  browser.on('error', error => { spawnError = error; });
  // close also follows a failed spawn, which never emits exit.
  const closed = new Promise(resolve => browser.once('close', resolve));
  const failure = reason => new Error(`Pause fixture ${reason}; pid=${browser.pid ?? 'unavailable'}; stderr=${stderr.trim() || '<empty>'}`,
    spawnError ? { cause: spawnError } : undefined);
  const heartbeat = async () => JSON.parse(await readFile(path.join(profile, 'heartbeat.json'), 'utf8'));
  const nextHeartbeat = async sequence => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const value = await heartbeat();
      if (value.sequence > sequence) return value;
      if (browser.exitCode !== null || browser.signalCode !== null) throw failure('exited while waiting for heartbeat progress');
      if (Date.now() >= deadline) throw failure(`heartbeat did not advance past ${sequence}`);
      await sleep(10);
    }
  };
  try {
    let timer, readyResolve, readyReject;
    const onMessage = message => { if (message === 'ready') readyResolve(); };
    const onError = () => readyReject(failure(`spawn failed (${spawnError?.code || 'unknown'})`));
    const onClose = (code, signal) => readyReject(failure(`exited before ready (code=${code}, signal=${signal})`));
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    browser.on('message', onMessage);browser.once('error', onError);browser.once('close', onClose);
    timer = setTimeout(() => readyReject(failure(`did not become ready within ${startupTimeoutMs}ms`)), startupTimeoutMs);
    try { await ready; }
    finally {
      clearTimeout(timer);browser.off('message', onMessage);browser.off('error', onError);browser.off('close', onClose);
    }
    // The ready message is sent only after the first atomic heartbeat write.
    await heartbeat();
    await run({ pid: browser.pid, profile, heartbeat, nextHeartbeat });
  } finally {
    let timer;
    try {
      browser.kill('SIGCONT');browser.kill('SIGTERM');
      timer = setTimeout(() => browser.kill('SIGKILL'), 5000);
      await closed;
    } finally { clearTimeout(timer);await rm(profile, { recursive: true, force: true }); }
  }
}

test('pause fixture waits for a delayed first heartbeat before entering the scenario', { skip: process.platform !== 'linux' }, async () => {
  let parent, child, directory;
  await fixture(async ({ pid, profile, heartbeat }) => {
    const value = await heartbeat();
    assert.ok(value.sequence > 0);
    parent = pid;child = value.child;directory = profile;
  }, { startupDelayMs: 1300 });
  for (const pid of [parent, child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('pause fixture reports early exit and captured stderr without entering the scenario', { skip: process.platform !== 'linux' }, async () => {
  await assert.rejects(fixture(() => assert.fail('scenario must not start'), {
    script: "process.stderr.write('startup failure detail',()=>process.exit(23))"
  }), error => /exited before ready \(code=23, signal=null\)/.test(error.message) && error.message.includes('startup failure detail'));
});

test('pause fixture rejects spawn errors without waiting for a nonexistent exit event', { skip: process.platform !== 'linux' }, async () => {
  await assert.rejects(fixture(() => assert.fail('scenario must not start'), {
    executable: '/definitely-missing-bd-pause-node'
  }), error => /spawn failed \(ENOENT\)/.test(error.message) && error.cause?.code === 'ENOENT');
});

test('pause fixture bounds a live child that never signals readiness', { skip: process.platform !== 'linux' }, async () => {
  await assert.rejects(fixture(() => assert.fail('scenario must not start'), {
    script: 'setInterval(()=>{},1000)', startupTimeoutMs: 100
  }), /did not become ready within 100ms/);
});

test('native pause watchdog stops both the owned parent and its descendant, then resumes them', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ pid, profile, heartbeat, nextHeartbeat }) => {
    const before = await heartbeat();
    const result = await pauseOwnedBrowser({ pid, profile, milliseconds: 300 });
    assert.equal(result.deviceSleep, false);
    assert.ok(result.heldMs >= 300);
    assert.ok(result.stopped.some(item => item.pid === pid));
    assert.ok(result.stopped.some(item => item.pid === before.child));
    assert.ok(result.stopped.every(item => item.state === 'T'));
    assert.deepEqual(result.afterHold, result.stopped);
    assert.deepEqual([...result.resumed].sort((a,b)=>a-b), result.stopped.map(p=>p.pid).sort((a,b)=>a-b));
    const afterPause = await heartbeat();
    assert.ok((await nextHeartbeat(afterPause.sequence)).sequence > afterPause.sequence, 'real heartbeat resumes');
  });
});

test('native pause rejects a profile mismatch before sending any signal', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ pid, profile, heartbeat, nextHeartbeat }) => {
    const before = await heartbeat();
    await assert.rejects(pauseOwnedBrowser({ pid, profile: path.dirname(profile), milliseconds: 300 }), /does not own/);
    assert.ok((await nextHeartbeat(before.sequence)).sequence > before.sequence);
  });
});

test('native pause rejects the test runner itself', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ profile }) => {
    await assert.rejects(pauseOwnedBrowser({ pid: process.pid, profile, milliseconds: 300 }), /Invalid fixture/);
  });
});

test('native pause rejects unbounded and malformed durations without stopping the child', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ pid, profile, heartbeat, nextHeartbeat }) => {
    for (const milliseconds of [0, 180001, 300.5, '300']) {
      await assert.rejects(pauseOwnedBrowser({ pid, profile, milliseconds }), /duration/);
    }
    const before = await heartbeat();
    assert.ok((await nextHeartbeat(before.sequence)).sequence > before.sequence);
  });
});

test('an interrupted stop fails the proof and still resumes every pinned process', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ pid, profile, heartbeat, nextHeartbeat }) => {
    let stopped;
    const entered = new Promise(resolve => { stopped = resolve; });
    const pending = pauseOwnedBrowser({ pid, profile, milliseconds: 1000, onStopped: stopped });
    // Attach rejection handling before this deliberately broken interleaving.
    const result = pending.then(value => ({ value }), error => ({ error }));
    await Promise.race([entered, pending.then(() => { throw new Error('Pause completed before its stop receipt'); })]);
    // Capture while fully stopped. A sample after watchdog cleanup races
    // with already-resumed heartbeats and a fixed 40ms sleep under CI load.
    const before = await heartbeat();
    process.kill(pid, 'SIGCONT');
    const { error } = await result;
    assert.match(error?.message || '', /ran or changed identity/);
    assert.equal(error.report.status, 'failed');
    assert.ok(error.report.resumed.includes(pid));
    assert.ok((await nextHeartbeat(before.sequence)).sequence > before.sequence, 'heartbeat advanced after the deliberate early resume');
  });
});
