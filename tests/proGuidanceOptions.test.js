import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuidanceHub, priorState, settle, at } from './helpers/optionsGuidanceHarness.js';
import { PRO_TIP_KEYS } from '../options/userGuidance.js';

// These assertions run against the actual Options methods and shared storage.
test('concurrent Options renders finish with exactly one tip', async () => {
  const h = createGuidanceHub({ state: priorState({ lastShownDay: '2026-09-30' }) });
  const p = h.page();
  await Promise.all([p.page.renderProTips(true),p.page.renderProTips(true)]);
  await settle();
  assert.equal(p.tip().length,1);
});

test('a delayed paid render cannot reappear after downgrade', async () => {
  const h = createGuidanceHub({ state: priorState() });
  const p = h.page();
  const gate = h.pauseRead();
  const old = p.page.renderProTips(true);
  await gate.started.promise;
  p.page.isPro = false;
  await p.page.renderProTips(false);
  gate.release.resolve();
  await old; await settle();
  assert.equal(p.visible(),false);
  assert.equal(p.tip().length,0);
  assert.equal(h.data.proGuidance.lastShownDay,'2026-09-29');
});

test('a stale next-day render cannot overwrite a completed dismiss', async () => {
  const h = createGuidanceHub({ state: priorState() });
  const p = h.page();
  const gate = h.pauseRead();
  const old = p.page.renderProTips(true);
  await gate.started.promise;
  await p.page.dismissProTips();
  gate.release.resolve();
  await old; await settle();
  assert.equal(h.data.proGuidance.dismissed,true);
  assert.equal(p.visible(),false);
});

test('dismiss synchronizes two open Options sharing storage', async () => {
  const h = createGuidanceHub({ state: priorState({ lastShownDay: '2026-09-30' }) });
  const a = h.page({ listen: true });
  const b = h.page({ listen: true });
  await Promise.all([a.page.renderProTips(true), b.page.renderProTips(true)]);
  await a.page.dismissProTips(); await settle();
  assert.equal(b.visible(),false);
  assert.equal(b.tip().length,0);
  assert.equal(h.data.proGuidance.dismissed,true);
});

test('a hidden Options does not create or advance Pro guidance', async () => {
  for (const state of [undefined, priorState()]) {
    const h = createGuidanceHub({ state });
    const p = h.page({ hidden: true });
    const before = structuredClone(h.data);
    await p.page.renderProTips(true); await settle();
    assert.deepEqual(h.data,before);
    assert.equal(p.visible(),false);
  }
});

test('activation during initialization cannot be overwritten by its old Free snapshot', async () => {
  const h = createGuidanceHub({ isPro: false });
  const p = h.page();
  const gate = h.pauseAccess();
  const init = p.page.init();
  await gate.started.promise;
  await h.setCredentials({ isPro: true, licenseKey: 'new-key' });
  h.broadcastStatus(true);
  await settle();
  gate.release.resolve();
  await init; await settle();
  assert.equal(p.page.isPro,true);
  assert.equal(p.visible(),true);
  assert.equal(p.tip().length,1);
});

test('two Options serialize delayed commits and dismiss without resurrecting state', async () => {
  const h = createGuidanceHub({ state: priorState() });
  const a = h.page({ listen: true });
  const b = h.page({ listen: true });
  const gate = h.pauseWrite();
  const renderA = a.page.renderProTips(true);
  await gate.started.promise;
  const renderB = b.page.renderProTips(true);
  await settle();
  const dismissB = b.page.dismissProTips();
  await settle();
  assert.equal(h.writes.length,0, 'dismiss waits for the shared writer, not a page-local queue');
  gate.release.resolve();
  await Promise.all([renderA,renderB,dismissB]); await settle();
  assert.deepEqual(h.data.proGuidance,priorState({ tipIndex: 1, lastShownDay: '2026-09-30', dismissed: true }));
  assert.equal(h.writes.length,2);
  assert.equal(h.writes[1].proGuidance.dismissed,true);
  assert.equal(a.visible(),false);
  assert.equal(b.visible(),false);
});

test('an old render in another Options cannot overwrite a newer completed cycle', async () => {
  const h = createGuidanceHub({ state: priorState({ tipIndex: 6 }) });
  const a = h.page(); // Deliberately no listener: writer protection must stand on its own.
  const b = h.page({ listen: true });
  const gate = h.pauseRead();
  const old = a.page.renderProTips(true);
  await gate.started.promise;
  await b.page.renderProTips(true); await settle();
  assert.equal(h.data.proGuidance.tipIndex,7);
  h.setTime(at(1,9,9));
  await b.page.renderProTips(true); await settle();
  assert.equal(h.data.proGuidance.completed,true);
  gate.release.resolve();
  await old; await settle();
  assert.equal(h.data.proGuidance.completed,true);
  assert.equal(h.data.proGuidance.lastShownDay,'2026-10-01');
  assert.equal(a.visible(),false);
  assert.equal(b.visible(),false);
  assert.equal(h.writes.length,2);
});

test('a delayed preview hidden before its result consumes no tip until visibility returns', async () => {
  const h = createGuidanceHub({ state: priorState() });
  const p = h.page({ listen: true });
  const gate = h.pauseRead();
  const render = p.page.renderProTips(true);
  await gate.started.promise;
  await p.visibility(false);
  gate.release.resolve();
  await render; await settle();
  assert.deepEqual(h.data.proGuidance,priorState());
  assert.equal(h.writes.length,0);
  assert.equal(p.visible(),false);
  await p.visibility(true);
  assert.equal(p.visible(),true);
  assert.deepEqual(p.tip(),[PRO_TIP_KEYS[1]]);
  assert.equal(h.data.proGuidance.tipIndex,1);
  assert.equal(h.writes.length,1);
});

test('hidden init and activation messages defer first use until returning visibility', async () => {
  const h = createGuidanceHub({ isPro: false });
  const p = h.page({ hidden: true });
  await p.page.init();
  await h.setCredentials({ isPro: true, licenseKey: 'activated' });
  h.broadcastStatus(true); h.broadcastStatus(true);
  await settle();
  assert.equal(p.page.isPro,true);
  assert.deepEqual(h.data,{});
  assert.equal(h.requests.length,0);
  assert.equal(p.visible(),false);
  await p.visibility(true);
  assert.deepEqual(p.tip(),[PRO_TIP_KEYS[0]]);
  assert.deepEqual(h.data.proGuidance,priorState({ lastShownDay: '2026-09-30' }));
  assert.equal(h.writes.length,1);
});

for (const [label, isPro, installationDate, allowed] of [
  ['Pro',true,'2026-08-01T00:00:00Z',true],
  ['trusted-date Legacy',false,'2025-12-31T23:59:59Z',true],
  ['Free at cutoff',false,'2026-01-01T00:00:00Z',false],
  ['Free without installation date',false,null,false],
  ['Free with invalid installation date',false,'not-a-date',false]
]) {
  test(label + ': init and repeated status notifications use actual access', async () => {
    const h = createGuidanceHub({ isPro, installationDate });
    const p = h.page();
    await p.page.init();
    h.broadcastStatus(false); h.broadcastStatus(true); // Payload does not grant access.
    await settle();
    assert.equal(p.visible(),allowed);
    assert.deepEqual(p.tip(),allowed ? [PRO_TIP_KEYS[0]] : []);
    assert.equal(h.writes.length,allowed ? 1 : 0);
    if (allowed) assert.equal(h.data.proGuidance.tipIndex,0);
    else assert.deepEqual(h.data,{});
  });
}

test('a stale Legacy flag cannot grant Free access or touch existing history', async () => {
  const h = createGuidanceHub({ isPro: false, state: priorState() });
  const p = h.page();
  await h.setCredentials({ isLegacyUser: true });
  await p.page.init();
  await p.page.renderProTips(true);
  assert.equal(p.page.isLegacyUser,false);
  assert.equal(p.visible(),false);
  assert.deepEqual(h.data.proGuidance,priorState());
  assert.equal(h.writes.length,0);
});

test('logout while a preview waits hides both Options and preserves history', async () => {
  const h = createGuidanceHub({ state: priorState() });
  const a = h.page({ listen: true });
  const b = h.page({ listen: true });
  const gate = h.pauseRead();
  const render = a.page.renderProTips(true);
  await gate.started.promise;
  await h.setCredentials({ isPro: false, licenseKey: null });
  h.broadcastStatus(false);
  gate.release.resolve();
  await render; await settle();
  assert.equal(a.visible(),false);
  assert.equal(b.visible(),false);
  assert.deepEqual(h.data.proGuidance,priorState());
  assert.equal(h.writes.length,0);
});

test('repeated status, key replacement, logout and reactivation preserve the same-day tip', async () => {
  const original = priorState({ tipIndex: 4, lastShownDay: '2026-09-30' });
  const h = createGuidanceHub({ state: original });
  const p = h.page();
  await p.page.init();
  h.broadcastStatus(true); h.broadcastStatus(true); await settle();
  await h.setCredentials({ isPro: false, licenseKey: null });
  h.broadcastStatus(false); await settle();
  assert.equal(p.visible(),false);
  await h.setCredentials({ isPro: true, licenseKey: 'replacement-key' });
  h.broadcastStatus(true); await settle();
  assert.deepEqual(p.tip(),[PRO_TIP_KEYS[4]]);
  assert.deepEqual(h.data.proGuidance,original);
  assert.equal(h.writes.length,0);
  p.close(); h.restartWorker(); h.setTime(at(15,9,11));
  const reopened = h.page(); await reopened.page.init(); await settle();
  assert.deepEqual(reopened.tip(),[PRO_TIP_KEYS[5]]);
  assert.equal(h.data.proGuidance.tipIndex,5,'a long gap advances only once');
  assert.equal(h.writes.length,1);
});

test('dismiss survives reopen, background restart, loss of Pro and license replacement', async () => {
  const h = createGuidanceHub({ state: priorState() });
  const p = h.page();
  // Dismissing an old state does not advance its unshown next-day tip.
  await p.page.dismissProTips();
  assert.deepEqual(h.data.proGuidance,priorState({ dismissed: true }));
  p.close(); h.restartWorker(); h.setTime(at(1,9,0,2027));
  await h.setCredentials({ isPro: false, licenseKey: null });
  const free = h.page(); await free.page.init();
  await h.setCredentials({ isPro: true, licenseKey: 'new-license' });
  h.broadcastStatus(true); await settle();
  assert.equal(free.visible(),false);
  free.close(); h.restartWorker();
  const reopened = h.page(); await reopened.page.init(); await settle();
  assert.deepEqual(reopened.tip(),[]);
  assert.equal(reopened.visible(),false);
  assert.deepEqual(h.data.proGuidance,priorState({ dismissed: true }));
  assert.equal(h.writes.length,1);
});

test('eighth tip lasts its whole shown day and completion persists on the next visiting day', async () => {
  const h = createGuidanceHub({ time: at(1) });
  let p = h.page(); await p.page.init(); await settle();
  for (let index = 1; index < PRO_TIP_KEYS.length; index++) {
    p.close(); h.restartWorker(); h.setTime(at(index + 1));
    p = h.page(); await p.page.init(); await settle();
    assert.deepEqual(p.tip(),[PRO_TIP_KEYS[index]]);
    assert.equal(h.data.proGuidance.tipIndex,index);
    assert.equal(h.data.proGuidance.completed,false);
  }
  h.setTime(at(8,23)); await p.page.renderProTips(true); await settle();
  assert.deepEqual(p.tip(),[PRO_TIP_KEYS[7]]);
  assert.equal(h.writes.length,8);
  h.setTime(at(9)); await settle();
  assert.equal(h.data.proGuidance.completed,false,'clock alone does not run a background timer');
  await p.visibility(false); await p.visibility(true);
  assert.equal(p.visible(),false);
  assert.equal(h.data.proGuidance.completed,true);
  const completed = structuredClone(h.data.proGuidance);
  p.close(); h.restartWorker(); h.setTime(at(1,9,0,2027));
  await h.setCredentials({ licenseKey: 'another-license' });
  p = h.page(); await p.page.init(); await settle();
  assert.equal(p.visible(),false);
  assert.deepEqual(h.data.proGuidance,completed);
  assert.equal(h.writes.length,9);
});

test('local midnight, month/year boundaries and clock rollback use calendar days', async () => {
  for (const [before, after, expectedDay] of [
    [new Date(2026,8,30,23,59,59),new Date(2026,9,1,0,0,1),'2026-10-01'],
    [new Date(2026,11,31,23,59,59),new Date(2027,0,1,0,0,1),'2027-01-01']
  ]) {
    const h = createGuidanceHub({ time: before.getTime() });
    const p = h.page(); await p.page.init(); await settle();
    h.setTime(after.getTime()); await p.page.renderProTips(true); await settle();
    assert.deepEqual(p.tip(),[PRO_TIP_KEYS[1]]);
    assert.equal(h.data.proGuidance.lastShownDay,expectedDay);
    h.setTime(before.getTime()); await p.page.renderProTips(true); await settle();
    assert.deepEqual(p.tip(),[PRO_TIP_KEYS[1]]);
    assert.equal(h.data.proGuidance.lastShownDay,expectedDay);
    assert.equal(h.writes.length,2);
  }
});

test('Kyiv DST short/long days and repeated local hour do not skip or repeat a step', async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'Europe/Kyiv';
  try {
    for (const [before,after,hours,expectedDay] of [
      [new Date(2026,2,28,12),new Date(2026,2,29,12),23,'2026-03-29'],
      [new Date(2026,9,24,12),new Date(2026,9,25,12),25,'2026-10-25']
    ]) {
      assert.equal((after-before)/3600000,hours);
      const h = createGuidanceHub({ time: before.getTime() });
      const p = h.page(); await p.page.init(); await settle();
      h.setTime(after.getTime()); await p.page.renderProTips(true); await settle();
      assert.deepEqual(p.tip(),[PRO_TIP_KEYS[1]]);
      assert.equal(h.data.proGuidance.lastShownDay,expectedDay);
      assert.equal(h.writes.length,2);
    }
    const h = createGuidanceHub({ time: Date.parse('2026-10-25T00:45:00Z') });
    const p = h.page(); await p.page.init(); await settle();
    h.setTime(Date.parse('2026-10-25T01:15:00Z'));
    await p.page.renderProTips(true); await settle();
    assert.deepEqual(p.tip(),[PRO_TIP_KEYS[0]]);
    assert.equal(h.data.proGuidance.lastShownDay,'2026-10-25');
    assert.equal(h.writes.length,1);
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
