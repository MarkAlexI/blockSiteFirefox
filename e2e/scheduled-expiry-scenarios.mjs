import assert from 'node:assert/strict';
import { assertNativeClock } from './calendar-scenarios.mjs';
import { inBackground, installScheduledExpiryProbe, readScheduledExpiryProbe } from './scheduled-expiry-probes.mjs';

const ruleId = 37;
const marker = '__bdScheduledExpiryProfile';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await pause(200);
  } while (Date.now() < deadline);
  assert.fail(`${label}: timeout; last=${JSON.stringify(value)}`);
}

async function evidence(e, label, value) {
  if (e.testInfo) await e.testInfo.attach(label, {
    contentType: 'application/json', body: JSON.stringify(value, null, 2)
  });
  else (e.result.scheduledExpiry ||= []).push({ label, ...value });
}

async function message(page, input) {
  return page.evaluate(async input => {
    if (globalThis.browser) return browser.runtime.sendMessage(input);
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(input, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(response);
    }));
  }, input);
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const api = globalThis.browser || chrome;
    return { ...await api.storage.local.get(['focusSchedule', 'focusSession', '__bdScheduledExpiryProfile']),
      alarms: await api.alarms.getAll(), dnr: await api.declarativeNetRequest.getDynamicRules() };
  });
}

const history = e => inBackground(e, readScheduledExpiryProbe);
const activeWrites = events => events.filter(event =>
  (event.type === 'storage-write-committed' && event.values.focusSession?.focusActive === true) ||
  (event.type === 'storage-changed' && event.changes.focusSession?.newValue?.focusActive === true));
const focusDnr = events => events.filter(event =>
  (event.type === 'dnr-update-called' && event.update.addRules?.some(rule => rule.id === ruleId)) ||
  (event.type === 'dnr-update-committed' && event.rules.some(rule => rule.id === ruleId)));

function assertInactive(state, keys) {
  assert.equal(state.focusSession.focusActive, false, 'expired occurrence cannot activate Focus');
  assert.deepEqual(state.focusSchedule.handledKeys, keys, 'only the expected durable claim remains');
  assert.deepEqual(state.dnr, [], 'inactive profile has no native blocking rules');
  assert.equal(state.alarms.some(alarm => alarm.name === 'end_focus_session'), false, 'no Focus completion alarm');
}

function assertNextAlarm(state, next) {
  assert.ok(next && next.startTime > Date.now(), 'next occurrence is future');
  const alarm = state.alarms.find(item => item.name === 'start_scheduled_focus');
  assert.ok(alarm, 'next scheduled occurrence has a native alarm');
  assert.equal(alarm.scheduledTime, next.startTime, 'native alarm targets the next occurrence');
}

async function expiry(e, phase) {
  await e.seed({ rules: [{ id: ruleId, blockURL: 'expiry.bd-e2e.test', redirectURL: '', category: 'social',
    isWhitelist: false, assignments: [{ listId: 'list-1', disabledByUser: false,
      blockingMode: 'always', schedule: null, dailyLimit: null }] }] });
  await e.writeLocal({ [marker]: phase });
  const page = await e.openOptions();
  await assertNativeClock(e, page, {}, 'expiry-native-clock-before');
  let observed;
  let installed = false;
  try {
    await inBackground(e, installScheduledExpiryProbe, { namespace: e.worker ? 'chrome' : 'browser' });
    installed = true;
    // Positive control: a genuine manual start/stop must be visible to BOTH
    // history observers. No result, storage event or DNR rule is synthesized.
    const started = await message(page, { type: 'start_focus_session', duration: 25 });
    assert.equal(started.success, true, JSON.stringify(started));
    assert.notEqual(started.superseded, true);
    await until(() => snapshot(page), state => state.focusSession.focusActive &&
      state.dnr.some(rule => rule.id === ruleId), 'manual Focus positive control');
    await until(() => history(e), value => activeWrites(value.events).length > 0 &&
      focusDnr(value.events).length > 0, 'history observes actual Focus and DNR activation');
    assert.equal((await message(page, { type: 'stop_focus_session' })).success, true);
    await until(() => snapshot(page), state => !state.focusSession.focusActive && !state.dnr.length,
      'manual Focus cleanup');
    await evidence(e, 'expiry-positive-control', await history(e));

    const config = await page.evaluate(() => {
      const now = new Date();
      // At least 15 seconds to persist, observe the alarm and arm the gate.
      const start = new Date(now.getTime() + (now.getSeconds() > 45 ? 120_000 : 60_000));
      return { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], durationMinutes: 1,
        startTime: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}` };
    });
    const initial = await message(page, { type: 'focus_schedule_get' });
    const saved = await message(page, { type: 'focus_schedule_save', config, revision: initial.revision });
    assert.equal(saved.success, true, JSON.stringify(saved));
    const occurrence = saved.next;
    assert.ok(occurrence && occurrence.startTime > Date.now(), 'gate is installed before occurrence begins');
    assertNextAlarm(await snapshot(page), occurrence);
    await inBackground(e, (view, gate) => {
      view.__bdScheduledExpiry.events = [];
      view.__bdScheduledExpiry.gate = gate;
    }, { phase, key: occurrence.key });

    const entered = await until(() => history(e), value => Boolean(value.gate.enteredAt),
      'native controller wait entered inside the occurrence', 100_000);
    assert.ok(entered.gate.enteredAt >= occurrence.startTime && entered.gate.enteredAt < occurrence.endTime,
      'the gate holds an originally current occurrence, not an already missed alarm');
    const keys = phase === 'after-claim' ? [occurrence.key] : [];
    const held = await snapshot(page);
    assertInactive(held, keys);
    if (phase === 'before-claim') assert.equal(entered.gate.nativeResult.focusSession.focusActive, false);
    else assert.deepEqual(entered.gate.nativeResult.focusSchedule.handledKeys, keys, 'actual claim write completed before hold');
    await evidence(e, 'expiry-held', { phase, occurrence, held, entered });

    // Real time passes. A native storage read in the background is a heartbeat
    // for this controlled interleaving; automatic idle unload is a separate test.
    await until(() => inBackground(e, async view => {
      await (view.browser || view.chrome).storage.local.get(['focusSchedule', 'focusSession']);
      return view.Date.now();
    }), now => now >= occurrence.endTime, 'real occurrence end reached while API delivery is held', 70_000);
    observed = await history(e);
    assert.equal(activeWrites(observed.events).length, 0, 'no transient Focus while held');
    assert.equal(focusDnr(observed.events).length, 0, 'no transient Focus DNR while held');
    await inBackground(e, view => view.__bdScheduledExpiry.release());
    // An unchanged save is a genuine transition-queue barrier behind reconcile.
    // It does not change revision/notBefore, remove the claim or invoke listeners.
    const settled = await message(page, { type: 'focus_schedule_save', config, revision: saved.revision });
    assert.equal(settled.success, true, JSON.stringify(settled));
    assert.equal(settled.revision, saved.revision);
    const completed = await snapshot(page);
    assertInactive(completed, keys);
    assert.equal(completed.focusSchedule.notBefore, held.focusSchedule.notBefore);
    assertNextAlarm(completed, settled.next);
    observed = await history(e);
    assert.ok(observed.gate.releasedAt >= occurrence.endTime, 'release follows native wall-clock expiry');
    assert.ok(observed.events.some(event => event.type === 'native-alarm' &&
      event.alarm.name === 'start_scheduled_focus' && event.alarm.scheduledTime === occurrence.startTime),
    'real Scheduled Focus alarm was delivered');
    assert.equal(activeWrites(observed.events).length, 0, 'no transient Focus after expired read/write delivery');
    assert.equal(focusDnr(observed.events).length, 0, 'no transient Focus DNR after expired read/write delivery');
    for (const event of observed.events.filter(item => item.type === 'dnr-update-committed')) {
      assert.deepEqual(event.rules, [], 'every observed native DNR commit stays unblocked');
    }
    await evidence(e, 'expiry-completed', { phase, occurrence, completed, settled, history: observed });
    await inBackground(e, view => view.__bdScheduledExpiry.restore());
    installed = false;

    const profile = e.profile;
    await e.restart();
    assert.equal(e.profile, profile, 'restart retains the same disposable profile');
    const reopened = await e.openOptions();
    await assertNativeClock(e, reopened, {}, 'expiry-native-clock-restarted');
    const restored = await snapshot(reopened);
    assertInactive(restored, keys);
    assert.equal(restored[marker], phase, 'durable profile marker survives without reseed');
    assert.deepEqual(restored.focusSchedule, completed.focusSchedule, 'restart retains the exact schedule and claim');
    const status = await message(reopened, { type: 'focus_schedule_get' });
    assertNextAlarm(restored, status.next);
    const navigation = await e.newPage('http://expiry.bd-e2e.test/after-expiry');
    await until(() => navigation.url(), value => value === 'http://expiry.bd-e2e.test/after-expiry',
      'native navigation remains unblocked after restart');
    await evidence(e, 'expiry-restarted', { phase, occurrence, restored, status });
    assert.equal((await message(reopened, { type: 'focus_schedule_save',
      config: { ...config, enabled: false }, revision: status.revision })).success, true);
  } finally {
    if (installed) {
      observed = await history(e);
      await evidence(e, 'expiry-final-history', observed);
      await inBackground(e, view => view.__bdScheduledExpiry.restore());
    }
  }
}

export const scheduledExpiryScenarios = [
  { id: '37', persistent: true, timeout: 240_000,
    title: 'scheduled expiry smoke: native session read outlives occurrence without claim or transient Focus/DNR',
    run: e => expiry(e, 'before-claim') },
  { id: '38', persistent: true, timeout: 240_000,
    title: 'scheduled expiry smoke: native durable claim outlives occurrence without transient Focus/DNR or replay after restart',
    run: e => expiry(e, 'after-claim') }
];
