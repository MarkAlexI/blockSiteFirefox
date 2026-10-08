import assert from 'node:assert/strict';
import { observe } from './stale-scenarios.mjs';

const root = '[data-focus-schedule]';
const markerKey = '__bdCalendarProfile';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, check, label) {
  const until = Date.now() + 15_000;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await pause(100);
  } while (Date.now() < until);
  assert.fail(label + ': timeout; last=' + JSON.stringify(value));
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

function nativeClock() {
  const now = Date.now(); const local = new Date(now);
  return { now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: local.getTimezoneOffset(), date: String(local.getFullYear()) + '-' +
      String(local.getMonth() + 1).padStart(2, '0') + '-' + String(local.getDate()).padStart(2, '0'),
    nativeDate: Date.toString().includes('[native code]') && Date.now.toString().includes('[native code]') };
}

async function evidence(e, label, value) {
  if (e.testInfo) await e.testInfo.attach(label, {
    contentType: 'application/json', body: JSON.stringify(value, null, 2)
  });
  else (e.result.calendar ||= []).push({ label, ...value });
}

async function clock(e, page, expected, label) {
  const before = Date.now();
  const pageClock = await page.evaluate(nativeClock);
  const backgroundClock = await e.backgroundClock();
  const after = Date.now();
  await evidence(e, label, { pageClock, backgroundClock });
  for (const [realm, value] of Object.entries({ page: pageClock, background: backgroundClock })) {
    assert.equal(value.nativeDate, true, realm + ': original Date constructor and Date.now');
    if (expected.offset !== undefined) assert.equal(value.offset, expected.offset, realm + ': process TZ applied');
    if (expected.timezone) assert.equal(value.timezone, expected.timezone, realm + ': native timezone');
    assert.ok(value.now >= before - 2000 && value.now <= after + 2000, realm + ': real wall clock');
    assert.equal(value.date, new Date(value.now - value.offset * 60_000).toISOString().slice(0, 10),
      realm + ': local date matches the native offset');
  }
  assert.equal(backgroundClock.offset, pageClock.offset, 'Options and background use the same timezone');
  return pageClock;
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const api = globalThis.browser || chrome;
    return { ...await api.storage.local.get(['focusSchedule', 'focusSession', '__bdCalendarProfile']),
      alarms: await api.alarms.getAll(), dnr: await api.declarativeNetRequest.getDynamicRules() };
  });
}

function assertWaiting(state) {
  assert.equal(state.focusSession.focusActive, false, 'future local occurrence cannot activate Focus');
  assert.deepEqual(state.focusSchedule.handledKeys, [], 'no occurrence claimed');
  assert.deepEqual(state.dnr, [], 'inactive profile stays unblocked');
}

async function timezoneSkip(e, input) {
  const profile = e.profile;
  await e.restart({ timezone: input.from });
  await e.seed({ rules: [{ id: 32, blockURL: 'calendar.bd-e2e.test', redirectURL: '',
    category: 'social', isWhitelist: false, assignments: [{ listId: 'list-1',
      disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] }] });
  const a = await e.openOptions();
  await clock(e, a, { offset: input.fromOffset }, 'timezone-before');
  // Six real hours ahead keeps both zone variants future, even around midnight.
  const config = await a.evaluate(() => {
    const target = new Date(Date.now() + 6 * 60 * 60_000);
    return { enabled: true, days: [0, 1, 2, 3, 4, 5, 6],
      startTime: String(target.getHours()).padStart(2, '0') + ':' + String(target.getMinutes()).padStart(2, '0'),
      durationMinutes: 2 };
  });
  const initial = await message(a, { type: 'focus_schedule_get' });
  const shown = await message(a, { type: 'focus_schedule_save', config, revision: initial.revision });
  assert.equal(shown.success, true, JSON.stringify(shown));
  assert.ok(shown.next.startTime > Date.now());
  const token = { type: 'focus_schedule_skip', key: shown.next.key,
    revision: shown.revision, startTime: shown.next.startTime };
  const marker = input.from + '>' + input.to + ':' + shown.next.startTime;
  await e.writeLocal({ [markerKey]: marker });
  const original = await snapshot(a);
  assertWaiting(original);

  await e.restart({ timezone: input.to });
  assert.equal(e.profile, profile, 'same disposable profile across timezone restart');
  const b = await e.openOptions();
  await clock(e, b, { offset: input.toOffset }, 'timezone-after');
  const fresh = await message(b, { type: 'focus_schedule_get' });
  assert.equal(fresh.revision, shown.revision, 'timezone alone does not edit the schedule');
  assert.deepEqual(fresh.config, shown.config);
  assert.ok(fresh.next.startTime > Date.now());
  if (input.sameKey) assert.equal(fresh.next.key, shown.next.key, 'same local occurrence key');
  else assert.notEqual(fresh.next.key, shown.next.key, 'date-line change produces a different local occurrence key');
  assert.equal(fresh.next.startTime, shown.next.startTime - input.shiftHours * 60 * 60_000,
    'new absolute start is computed in the background timezone');
  // Independently construct the returned local occurrence using native page Date.
  const pageStart = await b.evaluate(next => {
    const [year, month, day] = next.key.slice(0, 10).split('-').map(Number);
    const [hour, minute] = next.key.slice(11).split(':').map(Number);
    return new Date(year, month - 1, day, hour, minute).getTime();
  }, fresh.next);
  assert.equal(fresh.next.startTime, pageStart, 'background occurrence agrees with native Options calendar');

  const current = await eventually(() => snapshot(b), state =>
    state.alarms.some(alarm => alarm.name === 'start_scheduled_focus' && alarm.scheduledTime === fresh.next.startTime),
  'native schedule alarm rearmed to the new absolute start');
  assert.equal(current[markerKey], marker, 'persisted marker survives without copying or reseeding storage');
  assert.deepEqual(current.focusSchedule, original.focusSchedule);
  assertWaiting(current);
  assert.deepEqual(await message(b, token), { success: false, code: 'schedule_changed' });
  const rejected = await snapshot(b);
  assert.deepEqual(rejected.focusSchedule, current.focusSchedule, 'stale Skip cannot mutate durable state');
  assertWaiting(rejected);

  await b.evaluate(() => { location.hash = '#focus-schedule'; });
  await eventually(() => b.evaluate(() => {
    const editor = document.querySelector('[data-focus-schedule]');
    return Boolean(editor?.open && !editor.querySelector('[data-focus-skip]').disabled);
  }), Boolean, 'fresh schedule editor ready');
  await observe(b);
  if (b.locator) await b.locator(root + ' [data-focus-skip]').click();
  else await b.click(root + ' [data-focus-skip]');
  const clicked = await eventually(() => b.evaluate(() =>
    window.__bdStale.calls.filter(item => item.message.type === 'focus_schedule_skip').at(-1)),
  value => value?.completed, 'fresh UI Skip native reply');
  assert.deepEqual(clicked.message, { type: 'focus_schedule_skip', key: fresh.next.key,
    revision: fresh.revision, startTime: fresh.next.startTime });
  assert.equal(clicked.response.success, true, JSON.stringify(clicked.response));
  const skipped = await snapshot(b);
  assert.deepEqual(skipped.focusSchedule.skippedKeys, [fresh.next.key]);
  assertWaiting(skipped);
  await evidence(e, 'timezone-skip', { originalToken: token, freshOccurrence: fresh.next,
    revision: fresh.revision, staleReply: { success: false, code: 'schedule_changed' },
    uiMessage: clicked.message, uiReply: clicked.response, marker, sameProfile: e.profile === profile });

  // No timezone argument: the harness must retain both the zone and storage.
  await e.restart();
  const c = await e.openOptions();
  await clock(e, c, { offset: input.toOffset }, 'timezone-after-skip-restart');
  const restored = await snapshot(c);
  assert.equal(e.profile, profile);
  assert.equal(restored[markerKey], marker);
  assert.deepEqual(restored.focusSchedule.skippedKeys, [fresh.next.key]);
  assertWaiting(restored);
  const next = await message(c, { type: 'focus_schedule_get' });
  assert.notEqual(next.next.key, fresh.next.key, 'fresh Skip stays consumed after restart');
}

export const calendarScenarios = [
  { id: '32', persistent: true,
    title: 'calendar smoke: process timezone change rejects same-key stale Skip, rearms alarm and preserves fresh UI Skip',
    run: e => timezoneSkip(e, { from: 'Etc/UTC', fromOffset: 0, to: 'Etc/GMT-1',
      toOffset: -60, sameKey: true, shiftHours: 1 }) },
  { id: '33', persistent: true,
    title: 'calendar smoke: date-line timezone restart rejects old local occurrence and persists the fresh Skip',
    run: e => timezoneSkip(e, { from: 'Etc/GMT+12', fromOffset: 720, to: 'Pacific/Kiritimati',
      toOffset: -840, sameKey: false, shiftHours: 2 }) },
  { id: '34', persistent: true,
    title: 'calendar smoke: native browser calendar skips the DST gap and consumes the repeated wall time once',
    async run(e) {
      await e.restart({ timezone: 'America/New_York' });
      const page = await e.openOptions();
      await clock(e, page, { timezone: 'America/New_York' }, 'dst-native-clock');
      // Fixed instants are arguments of the production pure calendar module.
      // Browser Date, the running wall clock and native alarms stay untouched.
      const vectors = await page.evaluate(async () => {
        const { defaultFocusSchedule, focusOccurrences, nextFocusOccurrence } =
          await import('../schedules/focusSchedule.js');
        const spring = { ...defaultFocusSchedule(), enabled: true, days: [0], startTime: '02:30' };
        const springNow = Date.parse('2026-03-08T05:00:00Z');
        const springItems = focusOccurrences(spring, springNow);
        const fall = { ...spring, startTime: '01:30', durationMinutes: 120 };
        const fallNow = Date.parse('2026-11-01T04:00:00Z');
        const fallItems = focusOccurrences(fall, fallNow);
        const repeated = Date.parse('2026-11-01T06:45:00Z');
        const key = '2026-11-01@01:30';
        return {
          spring: springItems[0], missing: springItems.filter(item => item.key.startsWith('2026-03-08@')),
          fall: fallItems.filter(item => item.key === key),
          duringRepeat: nextFocusOccurrence(fall, repeated),
          afterClaim: nextFocusOccurrence({ ...fall, handledKeys: [key] }, repeated),
          afterSkip: nextFocusOccurrence({ ...fall, skippedKeys: [key] }, repeated),
          offsets: ['2026-03-08T06:59:00Z', '2026-03-08T07:01:00Z',
            '2026-11-01T05:59:00Z', '2026-11-01T06:01:00Z'].map(value => new Date(value).getTimezoneOffset())
        };
      });
      assert.deepEqual(vectors.offsets, [300, 240, 240, 300], 'native engine observes both DST transitions');
      assert.deepEqual(vectors.missing, [], 'nonexistent 02:30 is not normalized into a launch');
      assert.equal(vectors.spring.key, '2026-03-15@02:30');
      assert.equal(vectors.spring.startTime, Date.parse('2026-03-15T06:30:00Z'));
      assert.deepEqual(vectors.fall, [{ key: '2026-11-01@01:30',
        startTime: Date.parse('2026-11-01T05:30:00Z'), endTime: Date.parse('2026-11-01T07:30:00Z') }]);
      assert.deepEqual(vectors.duringRepeat, vectors.fall[0], 'second fold is the same occurrence');
      for (const next of [vectors.afterClaim, vectors.afterSkip]) {
        assert.equal(next.key, '2026-11-08@01:30');
        assert.equal(next.startTime, Date.parse('2026-11-08T06:30:00Z'));
      }
      await evidence(e, 'dst-production-calendar-vectors', vectors);
    }
  }
];
