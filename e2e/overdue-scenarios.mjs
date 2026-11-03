import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pauseOwnedBrowser } from './browser-pause.mjs';
import { overdueFocusSettled } from './overdue-observation.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await wait(100);
  } while (Date.now() < end);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
const message = (page, input) => page.evaluate(input =>
  (globalThis.browser || globalThis.chrome).runtime.sendMessage(input), input);
const front = page => page.bringToFront ? page.bringToFront() : page.front();
const snapshot = page => page.evaluate(async () => {
  const api = globalThis.browser || globalThis.chrome;
  return { now: Date.now(), ...await api.storage.local.get([
    'rules', 'ruleLists', 'activeRuleListId', 'focusSession', 'focusSchedule',
    'dailyRuleUsage', 'pendingDailyUsageRemaps'
  ]), alarms: await api.alarms.getAll(), dnr: await api.declarativeNetRequest.getDynamicRules(),
  events: globalThis.__bdOverdueEvents || [] };
});
async function observe(page) {
  await page.evaluate(() => {
    const api = globalThis.browser || globalThis.chrome;
    if (globalThis.__bdOverdueEvents) throw new Error('Overdue observer already installed');
    const events = globalThis.__bdOverdueEvents = [];
    const record = (type, value) => events.push({ type, now: Date.now(), value: structuredClone(value) });
    api.alarms.onAlarm.addListener(alarm => record('alarm', alarm));
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const key of ['focusSession', 'focusSchedule', 'dailyRuleUsage']) {
        if (changes[key]) record(key, changes[key]);
      }
    });
  });
}
async function evidence(e, label, value) {
  if (e.testInfo) await e.testInfo.attach(label, {
    body: JSON.stringify(value, null, 2), contentType: 'application/json'
  });
  else {
    (e.result.overdue ||= {})[label] = value;
    await writeFile(path.join(e.config.output, `${label}.json`), JSON.stringify(value, null, 2) + '\n');
  }
}
async function freeze(e, label, milliseconds) {
  const pid = e.nativeOwner ? (await e.nativeOwner.diagnostics()).pid : e.result.browser['moz:processID'];
  try {
    const receipt = await pauseOwnedBrowser({ pid, profile: e.profile, milliseconds });
    await evidence(e, label, receipt);
    assert.ok(receipt.heldMs >= milliseconds, 'full browser tree remained stopped for the requested duration');
    assert.deepEqual([...receipt.resumed].sort((a,b) => a-b), receipt.stopped.map(p => p.pid).sort((a,b) => a-b));
    return receipt;
  } catch (error) {
    if (error.report) await evidence(e, label, error.report);
    throw error;
  }
}
async function navigation(e, url) {
  // The browser may abort the initial document when native DNR redirects it.
  const page = e.worker ? await e.context.newPage() : await e.newPage();
  try { await page.goto(url); }
  catch (error) { if (!/NS_BINDING_ABORTED|net::ERR_ABORTED/.test(String(error))) throw error; }
  return page;
}
const assignment = (listId, daily = false) => ({ listId, disabledByUser: false,
  blockingMode: daily ? 'daily_limit' : 'always', schedule: null,
  dailyLimit: daily ? { minutes: listId === 'general' ? 1 : 20 } : null });

async function focusAfterPause(e) {
  const rule = { id: 901, blockURL: 'overdue-focus.bd-e2e.test', redirectURL: '', category: 'social',
    isWhitelist: false, assignments: [assignment('list-1')] };
  await e.seed({ rules: [rule] });
  const page = await e.openOptions();
  await e.reconcile(page);
  const config = await page.evaluate(() => {
    const now = new Date();
    const start = new Date(now.getTime() + (now.getSeconds() > 45 ? 120_000 : 60_000));
    return { enabled: true, days: [0,1,2,3,4,5,6], durationMinutes: 1,
      startTime: `${String(start.getHours()).padStart(2,'0')}:${String(start.getMinutes()).padStart(2,'0')}` };
  });
  const original = await message(page, { type: 'focus_schedule_get' });
  const saved = await message(page, { type: 'focus_schedule_save', config, revision: original.revision });
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal((await message(page, { type: 'start_focus_session', duration: 1 })).success, true);
  const active = await until(() => snapshot(page), s => s.focusSession.focusActive &&
    s.dnr.some(rule => rule.id === 901), 'manual Focus has native blocking rules');
  await observe(page);
  const before = await snapshot(page);
  const occurrence = saved.next;
  assert.ok(occurrence.startTime - before.now > 5_000, 'pause starts before the scheduled occurrence');
  assert.ok(before.alarms.some(a => a.name === 'end_focus_session' && a.scheduledTime === active.focusSession.focusEndTime));
  assert.ok(before.alarms.some(a => a.name === 'start_scheduled_focus' && a.scheduledTime === occurrence.startTime));
  await evidence(e, 'focus-before-pause', { before, occurrence });
  const receipt = await freeze(e, 'focus-pause', Math.ceil(occurrence.endTime - Date.now()) + 3_000);
  assert.ok(receipt.fullyStoppedAt < occurrence.startTime);
  assert.ok(receipt.beforeResumeAt > occurrence.endTime);
  const after = await until(() => snapshot(page), overdueFocusSettled, 'native overdue Focus alarms and next occurrence settle');
  const completions = after.events.filter(v => v.type === 'focusSession' &&
    v.value.oldValue?.focusActive === true && v.value.newValue?.focusActive === false);
  assert.equal(completions.length, 1, 'one natural completion');
  assert.equal(after.events.some(v => v.type === 'focusSession' && v.value.newValue?.focusActive === true), false,
    'a completely missed scheduled occurrence never activates');
  assert.deepEqual(after.focusSchedule, before.focusSchedule, 'missed occurrence does not consume a claim or edit the schedule');
  assert.deepEqual(after.rules, before.rules);
  assert.deepEqual(after.ruleLists, before.ruleLists);
  assert.deepEqual(after.dailyRuleUsage.usageSeconds, before.dailyRuleUsage.usageSeconds);
  assert.equal(after.alarms.some(a => a.name === 'end_focus_session'), false);
  const next = after.alarms.find(a => a.name === 'start_scheduled_focus');
  assert.ok(next?.scheduledTime > after.now, 'next real occurrence is armed');
  await evidence(e, 'focus-after-pause', after);
  const allowed = await navigation(e, 'http://overdue-focus.bd-e2e.test/after');
  await until(() => allowed.url(), url => url === 'http://overdue-focus.bd-e2e.test/after', 'Focus navigation is now allowed');
  // Disable through the real controller before the independent Daily Limit phase.
  assert.equal((await message(page, { type: 'focus_schedule_save', config: { ...config, enabled: false }, revision: saved.revision })).success, true);
}

async function dailyAfterPause(e) {
  const rules = [
    { id: 902, blockURL: 'overdue-usage.bd-e2e.test', redirectURL: '', category: 'social',
      isWhitelist: false, assignments: [assignment('general', true)] },
    { id: 903, blockURL: 'overdue-other.bd-e2e.test', redirectURL: '', category: 'social',
      isWhitelist: false, assignments: [assignment('list-1', true)] }
  ];
  await e.seed({ rules, usage: { '902:general': 45, '903:list-1': 840 } });
  const page = await e.openOptions();
  await e.reconcile(page);
  await observe(page);
  const visible = await navigation(e, 'http://overdue-usage.bd-e2e.test/foreground');
  await front(visible);
  assert.equal(await visible.evaluate(() => document.visibilityState), 'visible');
  // A real focus/navigation event establishes the foreground segment. No
  // stored sample timestamp, usage amount, Date, or alarm is rewritten here.
  const before = await until(() => snapshot(page), s =>
    s.dailyRuleUsage.lastSample?.assignmentKeys.includes('902:general') &&
    s.alarms.some(a => a.name === 'daily_limit_deadline' && a.scheduledTime > s.now), 'native foreground deadline');
  await evidence(e, 'daily-before-pause', before);
  const receipt = await freeze(e, 'daily-pause', 95_000);
  const deadline = before.alarms.find(a => a.name === 'daily_limit_deadline');
  assert.ok(receipt.fullyStoppedAt < deadline.scheduledTime, 'browser stops before the native deadline');
  assert.ok(receipt.beforeResumeAt > deadline.scheduledTime, 'deadline elapses with every browser process stopped');
  const after = await until(() => snapshot(page), s =>
    s.events.some(v => v.type === 'alarm' && v.value.name === 'daily_limit_deadline') &&
    s.dailyRuleUsage.lastSample?.timestamp >= receipt.beforeResumeAt &&
    s.alarms.some(a => a.name === 'daily_limit_deadline' && a.scheduledTime > s.now), 'overdue Daily Limit sample and fresh deadline');
  const oldUsage = before.dailyRuleUsage.usageSeconds['902:general'];
  const resumedUsage = after.dailyRuleUsage.usageSeconds['902:general'];
  assert.ok(resumedUsage >= oldUsage && resumedUsage <= oldUsage + 2, '95-second gap does not consume the remaining budget');
  assert.equal(after.dailyRuleUsage.usageSeconds['903:list-1'], 840, 'other profile budget survives');
  assert.deepEqual(after.rules, before.rules);
  assert.deepEqual(after.ruleLists, before.ruleLists);
  assert.deepEqual(after.pendingDailyUsageRemaps, []);
  assert.equal(after.dnr.some(rule => rule.id === 902), false, 'foreground remains usable after the gap');
  await evidence(e, 'daily-after-pause', after);
  // Positive control: actual awake foreground time still exhausts the budget.
  const exhausted = await until(() => snapshot(page), s => s.dailyRuleUsage.usageSeconds['902:general'] >= 60 &&
    s.dnr.some(rule => rule.id === 902), 'awake foreground reaches the native limit', 30_000);
  assert.equal(exhausted.dailyRuleUsage.usageSeconds['903:list-1'], 840);
  await evidence(e, 'daily-awake-control', exhausted);
  const blocked = await navigation(e, 'http://overdue-usage.bd-e2e.test/blocked');
  await until(() => blocked.url(), url => url.includes('/blocked.html') && url.includes('reason=daily_limit'), 'native Daily Limit navigation blocks');
}

export const overdueScenarios = [{ id: '65', timeout: 330_000,
  title: 'overdue timers: a native browser process pause expires Focus, skips a missed schedule and preserves then consumes the Daily Limit budget',
  run: async e => { await focusAfterPause(e); await dailyAfterPause(e); }
}];
