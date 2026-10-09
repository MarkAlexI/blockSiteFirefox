import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import firefox from 'selenium-webdriver/firefox.js';
import { dailyRule, SITE, poll, equalEventually } from './fixtures.mjs';
import { installIdleObserver, readIdleObserver, removeIdleObserver } from './idle-probes.mjs';
import { observeEventPageIdle } from './native-idle.mjs';
import { installAlarmWakeObserver, readAlarmWakeObserver, resetAlarmWakeHistory,
  removeAlarmWakeObserver, readAlarmWakeColdState } from './alarm-wake-probes.mjs';
import { ALARM_BATCH, assertAlarmWakeHistory } from './native-alarm-wake.mjs';

const ids = state => state.dnr.map(rule => rule.id).sort((a, b) => a - b);
async function parent(e, fn, input = e.id) {
  await e.driver.setContext(firefox.Context.CHROME);
  try { return await e.driver.executeScript(fn, input); }
  finally { await e.driver.setContext(firefox.Context.CONTENT); }
}

async function alarmWake(e, expired) {
  const crossList = { id: 22, blockURL: 'study-alarms.bd-e2e.test', redirectURL: '', category: 'social',
    isWhitelist: false, assignments: [{ listId: 'list-1', disabledByUser: false,
      blockingMode: 'always', schedule: null, dailyLimit: null }] };
  await e.seed({ rules: [dailyRule(), crossList], usage: { '21:general': 840 } });
  const options = await e.openOptions(); await e.reconcile(options);
  const popup = await e.openPopup(); // Reader tab; toolbar lifecycle is tested separately.
  await equalEventually(async () => ids(await e.state()), [21], 'initial daily budget blocks');
  await poll(() => e.probe.evaluate(() => browser.alarms.getAll()),
    values => values.find(alarm => alarm.name === 'check_pro_expiry')?.scheduledTime > Date.now() + 3_600_000,
    'fresh-install license alarm advanced', 45_000);
  const evidence = e.result.alarmWake = { expired, processId: e.result.browser['moz:processID'],
    profile: e.result.browser['moz:profile'] };
  await parent(e, installAlarmWakeObserver);
  let idleObserver = false;
  try {
    await popup.fill('#focus-duration', expired ? '1' : '3');
    if (!expired) await popup.click('#focus-hardcore-mode');
    await popup.click('#start-focus-btn');
    await equalEventually(async () => ids(await e.state()), [21, 22], 'UI manual Focus includes the inactive profile');
    const before = { ...await parent(e, readAlarmWakeColdState), credentials: (await e.state()).credentials };
    evidence.before = before;
    assert.equal(before.focusSession.focusActive, true);
    assert.equal(before.focusSession.isHardcore, !expired);
    const token = randomUUID(); evidence.token = token;
    const fixture = await e.probe.evaluate(async ({ expired, token, batch }) => {
      const calendar = await import(browser.runtime.getURL('schedules/focusSchedule.js'));
      const view = await browser.runtime.getBackgroundPage();
      view.__bdIdleGlobal = token;
      await browser.storage.session.set({ __bdIdleSession: token });
      const session = (await browser.storage.local.get('focusSession')).focusSession;
      const now = Date.now();
      const when = expired ? session.focusEndTime : now + 60_000;
      const start = new Date(now);
      start.setSeconds(0, 0);
      if (expired) start.setMinutes(start.getMinutes() - 2);
      const time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
      const schedule = { version: 1, enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startTime: time,
        durationMinutes: expired ? 1 : 5, revision: 7, notBefore: 0, handledKeys: [], skippedKeys: [] };
      // Durable overdue/current schedule fixture; no controller/listener call.
      await browser.storage.local.set({ focusSchedule: schedule });
      const current = calendar.focusOccurrences(schedule, when).find(item => item.startTime <= when) || null;
      const next = calendar.nextFocusOccurrence({ ...schedule, handledKeys: current ? [current.key] : [] }, when);
      // All alarms use the real API/timers. Change their creation order between
      // cases, but observe Firefox's actual delivery order without prescribing it.
      for (const name of expired ? batch : [...batch].reverse()) {
        await browser.alarms.create(name, { when, ...(name === 'update_scheduled_rules' ? { periodInMinutes: 1 } : {}) });
      }
      return { when, schedule, current, next, clock: { now, nativeDate: Date.toString().includes('[native code]'),
        nativeNow: Date.now.toString().includes('[native code]'), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        nativeAlarms: await browser.alarms.getAll() };
    }, { expired, token, batch: ALARM_BATCH });
    evidence.fixture = fixture;
    assert.equal(fixture.clock.nativeDate && fixture.clock.nativeNow, true);
    assert.equal(Boolean(fixture.current), !expired, 'fixture distinguishes expired and current schedule windows');
    assert.ok(fixture.next.startTime > fixture.when);
    assert.deepEqual((await parent(e, readAlarmWakeColdState)).focusSchedule, fixture.schedule, 'claim not consumed during setup');
    evidence.positiveControl = await parent(e, resetAlarmWakeHistory);
    assert.deepEqual(evidence.positiveControl.errors, []);
    assert.ok(evidence.positiveControl.events.some(event => event.type === 'storage' && event.changes.focusSession?.newValue?.focusActive),
      'parent observer saw the genuine UI Focus activation');
    assert.ok(evidence.positiveControl.events.some(event => event.type === 'dnr' && event.rules.some(rule => rule.id === 22)),
      'parent observer saw the applied native Focus DNR');
    assert.deepEqual(await parent(e, installIdleObserver), { idleTimeout: 30_000, idleTimeoutOverridden: false },
      'unmodified native idle timeout');
    idleObserver = true;
    e.phase = 'native-multiple-alarm-wake';
    const keeper = await e.newPage(); await keeper.front();
    for (const handle of await e.driver.getAllWindowHandles()) {
      if (handle === keeper.context) continue;
      await e.driver.switchTo().window(handle); await e.driver.close();
    }
    await e.driver.switchTo().window(keeper.context);
    e.probe = null; e.options = [];
    evidence.keeper = keeper.context;
    const closedAt = Date.now();
    await observeEventPageIdle({ read: () => parent(e, readIdleObserver), closedAt,
      processId: evidence.processId, profile: evidence.profile, alarm: { name: 'native Focus alarm batch', scheduledTime: fixture.when },
      competingAlarms: fixture.nativeAlarms.filter(alarm => !ALARM_BATCH.includes(alarm.name)), evidence });
    // Only parent backends until the entire native alarm batch and its durable
    // results have been checked. Opening a reader could otherwise repair them.
    const expectedSchedule = { ...fixture.schedule, handledKeys: expired ? [] : [fixture.current.key] };
    const cold = await poll(async () => {
      const state = await parent(e, readAlarmWakeColdState);
      const observation = await parent(e, readAlarmWakeObserver);
      evidence.coldState = state; evidence.observation = observation;
      return { state, observation };
    }, ({ state, observation }) => observation.events.filter(event => event.type === 'alarm').length === 3 &&
      state.focusSession.focusActive === !expired && isDeepStrictEqual(ids(state), expired ? [21] : [21, 22]) &&
      isDeepStrictEqual(state.focusSchedule, expectedSchedule) &&
      (state.statistics?.successfulFocusSessions ?? 0) === (before.statistics?.successfulFocusSessions ?? 0) + Number(expired) &&
      (expired ? !observation.nativeAlarms.some(alarm => alarm.name === 'end_focus_session') :
        observation.nativeAlarms.find(alarm => alarm.name === 'end_focus_session')?.scheduledTime === before.focusSession.focusEndTime) &&
      observation.nativeAlarms.find(alarm => alarm.name === 'start_scheduled_focus')?.scheduledTime === fixture.next.startTime,
    'cold native batch restored Focus, claims, budget and alarms');
    assertAlarmWakeHistory({ observation: cold.observation, cold: cold.state, before, fixture, token, expired });
    assert.deepEqual(await e.driver.getAllWindowHandles(), [keeper.context], 'same native keeper without restart');
    e.phase = 'multiple-alarm-wake-ui';
    e.probe = await e.openPopup();
    evidence.restoredIdentity = await e.probe.evaluate(async () => {
      const view = await browser.runtime.getBackgroundPage();
      return { global: view.__bdIdleGlobal ?? null,
        session: (await browser.storage.session.get('__bdIdleSession')).__bdIdleSession };
    });
    assert.deepEqual(evidence.restoredIdentity, { global: null, session: token }, 'new global and surviving native session');
    const restoredOptions = await e.openOptions();
    const visible = page => page.evaluate(() => getComputedStyle(document.querySelector('#focus-active-view')).display !== 'none');
    await equalEventually(() => visible(e.probe), !expired, 'Popup reader agrees with cold Focus state');
    await equalEventually(() => restoredOptions.evaluate(() => getComputedStyle(document.querySelector('#focus-session-banner')).display !== 'none'),
      !expired, 'Options agrees with cold Focus state');
    assert.deepEqual((await e.state()).credentials, before.credentials, 'credentials preserved across idle/wake');
    await restoredOptions.hasClass('tr[data-rule-id="21"] .daily-limit-status', 'limit-reached');
    await e.assertBlocked(`${SITE}/native-alarm-budget`, expired ? 'daily_limit' : 'focus');
    if (expired) {
      const allowed = await e.newPage('http://study-alarms.bd-e2e.test/after-focus');
      await equalEventually(() => allowed.url(), 'http://study-alarms.bd-e2e.test/after-focus', 'inactive profile allowed after completion');
    } else await e.assertBlocked('http://study-alarms.bd-e2e.test/current-focus', 'focus');
    evidence.afterUi = await parent(e, readAlarmWakeColdState);
    evidence.finalHistory = await parent(e, readAlarmWakeObserver);
    // UI/status requests must not replay a consumed or expired occurrence.
    assertAlarmWakeHistory({ observation: evidence.finalHistory, cold: evidence.afterUi, before, fixture, token, expired });
  } finally {
    try {
      evidence.finalObservation = await parent(e, readAlarmWakeObserver);
      if (idleObserver) evidence.finalLifecycle = await parent(e, readIdleObserver);
    } finally {
      try { if (idleObserver) await parent(e, removeIdleObserver); }
      finally {
        await parent(e, removeAlarmWakeObserver);
        await writeFile(path.join(e.config.output, 'native-alarm-wake.json'), JSON.stringify(evidence, null, 2) + '\n');
      }
    }
  }
}

export const alarmWakeScenarios = [
  { id: '41', title: 'native alarm batch after idle unload completes expired Focus without activating an expired schedule',
    run: e => alarmWake(e, true) },
  { id: '42', title: 'native alarm batch after idle unload preserves newer manual Focus and consumes the current schedule once',
    run: e => alarmWake(e, false) }
];
