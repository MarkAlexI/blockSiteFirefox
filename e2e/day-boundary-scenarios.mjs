import assert from 'node:assert/strict';
import { assertNativeClock, recordCalendarEvidence } from './calendar-scenarios.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const markerKey = '__bdDayBoundaryProfile';
const assignment = listId => ({ listId, disabledByUser: false,
  blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 10 } });
const rules = listId => [35, 36].map(id => ({ id,
  blockURL: id === 35 ? 'day-usage.bd-e2e.test' : 'day-spent.bd-e2e.test',
  redirectURL: '', category: 'social', isWhitelist: false, assignments: [assignment(listId)] }));
const remaps = [35, 36].map(id => ({
  oldRuleId: id, oldListId: 'list-1', newRuleId: id, newListId: 'general'
}));

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

async function front(page) {
  if (page.front) await page.front(); else await page.bringToFront();
}

async function checkpoint(e, page, label) {
  const state = await e.state();
  const extra = await page.evaluate(async () => {
    const api = globalThis.browser || chrome;
    return { ...await api.storage.local.get('__bdDayBoundaryProfile'),
      alarms: await api.alarms.getAll() };
  });
  const value = { ...state, ...extra };
  await recordCalendarEvidence(e, label, value);
  return value;
}

async function settled(e, page, date, usage, dnr, label) {
  const state = await eventually(() => e.state(), value =>
    value.dailyRuleUsage?.date === date &&
    JSON.stringify(value.dailyRuleUsage.usageSeconds) === JSON.stringify(usage) &&
    value.pendingDailyUsageRemaps?.length === 0 &&
    JSON.stringify(value.dnr.map(item => item.id).sort((a, b) => a - b)) === JSON.stringify(dnr),
  label);
  assert.deepEqual(state.dailyRuleUsage.usageSeconds, usage);
  assert.deepEqual(state.pendingDailyUsageRemaps, [], 'journal consumed');
  assert.deepEqual(state.rules, rules('general'), 'committed assignments survive recovery');
  assert.equal(state.activeRuleListId, 'general');
  assert.equal(state.credentials.isPro, true);
  assert.equal(state.focusSession.focusActive, false);
  const current = await checkpoint(e, page, label);
  assert.ok(current.alarms.some(alarm =>
    alarm.name === 'update_scheduled_rules' && alarm.periodInMinutes === 1),
  'native periodic recovery alarm restored');
  return current;
}

async function readers(e, first, usage, exhausted = []) {
  const pages = [first, await e.openOptions(), await e.openPopup()];
  const expected = [35, 36].map(id => ({
    id, usage: Math.min(10, Math.floor((usage[id + ':general'] || 0) / 6) / 10),
    minutes: 10, exhausted: exhausted.includes(id)
  }));
  const checkRows = page => eventually(() => page.evaluate(() => [...document.querySelectorAll(
      '#rules-container tr[data-rule-id], #rules-container .rule[data-rule-id]'
    )].map(row => {
      const status = row.querySelector('.daily-limit-status, .rule-daily-limit-popup');
      const values = status?.textContent.match(/^([\d.]+)\s*\/\s*(\d+)/);
      return { id: Number(row.dataset.ruleId), usage: values ? Number(values[1]) : null,
        minutes: values ? Number(values[2]) : null,
        exhausted: Boolean(status?.classList.contains('limit-reached')) };
    }).sort((a, b) => a.id - b.id)), value => JSON.stringify(value) === JSON.stringify(expected),
    'Options/Popup agree with recovered assignment budgets');
  for (const page of pages) await checkRows(page);
  await pages[2].goto(e.popupUrl);
  await checkRows(pages[2]);
  await front(first);
  return pages;
}

async function foregroundSegment(e, options, listId, label) {
  const key = '35:' + listId;
  const initial = (await e.state()).dailyRuleUsage.usageSeconds[key] || 0;
  const page = await e.newPage('http://day-usage.bd-e2e.test/' + label);
  await front(page);
  await eventually(() => page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent,
    visible: document.visibilityState, focused: document.hasFocus()
  })), value => value.title === 'BD E2E fixture' &&
    value.visible === 'visible' && value.focused === true, 'native visible and focused fixture');
  const active = await options.evaluate(async () => {
    const api = globalThis.browser || chrome;
    return (await api.tabs.query({ active: true, currentWindow: true }))[0]?.url;
  });
  assert.equal(active, 'http://day-usage.bd-e2e.test/' + label, 'actual active browser tab');
  const running = await eventually(() => e.state(), state =>
    JSON.stringify(state.dailyRuleUsage.lastSample?.assignmentKeys) === JSON.stringify([key]),
  'native foreground accounting started');
  await pause(2200);
  await front(options);
  const stopped = await eventually(() => e.state(), state =>
    state.dailyRuleUsage.usageSeconds[key] > initial &&
    state.dailyRuleUsage.lastSample?.assignmentKeys.length === 0,
  'native foreground segment closed and persisted');
  const delta = stopped.dailyRuleUsage.usageSeconds[key] - initial;
  assert.ok(delta > 0 && delta < 15, 'bounded real foreground charge: ' + delta);
  await recordCalendarEvidence(e, label, { active, delta, running: running.dailyRuleUsage,
    stopped: stopped.dailyRuleUsage });
  return { running, stopped, delta };
}

async function stage(e, from, fromOffset, activeSample) {
  const profile = e.profile;
  await e.restart({ timezone: from });
  await e.seed({ rules: rules('list-1'), active: 'list-1',
    usage: { '35:list-1': 120, '36:list-1': 840 } });
  const page = await e.openOptions();
  const beforeClock = await assertNativeClock(e, page, { offset: fromOffset }, 'day-before-clock');
  await e.reconcile(page);
  await eventually(() => e.state(), state =>
    JSON.stringify(state.dnr.map(item => item.id)) === '[36]', 'old exhausted budget blocks natively');
  const segment = await foregroundSegment(e, page, 'list-1', 'before-boundary');
  assert.equal(segment.stopped.dailyRuleUsage.date, beforeClock.date, 'fixture uses the current native day');
  const raw = { ...segment.stopped.dailyRuleUsage,
    lastSample: activeSample ? segment.running.dailyRuleUsage.lastSample : segment.stopped.dailyRuleUsage.lastSample };
  assert.deepEqual(raw.lastSample.assignmentKeys, activeSample ? ['35:list-1'] : []);
  const marker = 'day-boundary:' + beforeClock.now;
  // Durable post-commit/pre-recovery fixture. No storage method, Date, timer,
  // visibility probe or production listener is replaced.
  await e.writeLocal({ rules: rules('general'), activeRuleListId: 'general',
    dailyRuleUsage: raw, pendingDailyUsageRemaps: remaps, [markerKey]: marker });
  const durable = await checkpoint(e, page, 'pending-current-day-journal');
  assert.deepEqual(durable.dailyRuleUsage, raw, 'real current-day counters and native sample persisted');
  assert.deepEqual(durable.pendingDailyUsageRemaps, remaps, 'nonempty journal before restart');
  assert.equal(durable[markerKey], marker);
  return { profile, beforeClock, marker, raw };
}

async function preserved(e, page, initial) {
  assert.equal(e.profile, initial.profile, 'same disposable profile without reseeding');
  const stored = await page.evaluate(async () => {
    const api = globalThis.browser || chrome;
    return (await api.storage.local.get('__bdDayBoundaryProfile')).__bdDayBoundaryProfile;
  });
  assert.equal(stored, initial.marker, 'same persisted storage across restarts');
}

function dateLineZones(now) {
  // Keep both local midnights at least an hour away from this short scenario.
  // Each pair moves the date forward by at least 24 hours without changing Date.
  const hour = new Date(now).getUTCHours();
  if (hour === 9 || hour === 10) return {
    from: 'Etc/GMT+12', fromOffset: 720, to: 'Etc/GMT-12', toOffset: -720
  };
  if (hour === 11) return {
    from: 'Etc/GMT+10', fromOffset: 600, to: 'Pacific/Kiritimati', toOffset: -840
  };
  return { from: 'Etc/GMT+12', fromOffset: 720, to: 'Pacific/Kiritimati', toOffset: -840 };
}

export const dayBoundaryScenarios = [
  { id: '35', persistent: true,
    title: 'day-boundary smoke: same-day timezone restart consumes journal once and preserves foreground usage',
    async run(e) {
      const initial = await stage(e, 'Etc/UTC', 0, false);
      const hour = new Date(initial.beforeClock.now).getUTCHours();
      const zone = hour < 12 ? 'Etc/GMT-1' : 'Etc/GMT+1';
      const offset = hour < 12 ? -60 : 60;
      await e.restart({ timezone: zone });
      const page = await e.openOptions();
      const afterClock = await assertNativeClock(e, page, { offset }, 'same-day-after-clock');
      assert.equal(afterClock.date, initial.beforeClock.date, 'timezone changes without a day-key change');
      await preserved(e, page, initial);
      const usage = { '35:general': initial.raw.usageSeconds['35:list-1'], '36:general': 840 };
      await settled(e, page, afterClock.date, usage, [36], 'same-day remap recovery');
      await readers(e, page, usage, [36]);
      await e.assertBlocked('http://day-spent.bd-e2e.test/same-day', 'daily_limit');
      await front(page);
      await e.restart();
      const restored = await e.openOptions();
      await assertNativeClock(e, restored, { offset }, 'same-day-second-restart-clock');
      await preserved(e, restored, initial);
      await settled(e, restored, afterClock.date, usage, [36], 'second restart cannot duplicate or erase usage');
      await readers(e, restored, usage, [36]);
    } },
  { id: '36', persistent: true,
    title: 'day-boundary smoke: date-line ABA clears active-sample journal and never resurrects a previous budget',
    async run(e) {
      const zones = dateLineZones((await e.backgroundClock()).now);
      const initial = await stage(e, zones.from, zones.fromOffset, true);
      await e.restart({ timezone: zones.to });
      const page = await e.openOptions();
      const afterClock = await assertNativeClock(e, page, { offset: zones.toOffset }, 'new-day-clock');
      assert.ok(afterClock.date > initial.beforeClock.date, 'native local day moved forward');
      await preserved(e, page, initial);
      const fresh = await settled(e, page, afterClock.date, {}, [], 'new day discards source, target and active old sample');
      assert.deepEqual(fresh.dailyRuleUsage.lastSample?.assignmentKeys || [], [],
        'old active sample cannot charge the new day');
      await readers(e, page, {});
      const segment = await foregroundSegment(e, page, 'general', 'after-boundary');
      const usage = { '35:general': segment.delta };
      await settled(e, page, afterClock.date, usage, [], 'only the new foreground segment is charged');
      await readers(e, page, usage);
      await e.restart({ timezone: zones.from });
      const returned = await e.openOptions();
      const returnedClock = await assertNativeClock(e, returned, { offset: zones.fromOffset }, 'returned-day-clock');
      assert.equal(returnedClock.date, initial.beforeClock.date, 'timezone A-to-B-to-A returns to the original local day');
      await preserved(e, returned, initial);
      await settled(e, returned, returnedClock.date, {}, [], 'neither old-day nor intervening-day usage is resurrected');
      await readers(e, returned, {});
      const allowed = await e.newPage('http://day-spent.bd-e2e.test/returned-day');
      await eventually(() => allowed.evaluate(() => document.querySelector('h1')?.textContent),
        text => text === 'BD E2E fixture', 'previously exhausted URL is now permitted by native DNR');
    } }
];
