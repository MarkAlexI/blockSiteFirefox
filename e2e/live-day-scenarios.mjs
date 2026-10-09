import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import firefox from 'selenium-webdriver/firefox.js';
import { assignment, delay, poll, equalEventually } from './fixtures.mjs';
import { inBackground } from './scheduled-expiry-probes.mjs';
import { installLiveDayProbe, setBackgroundTimezone } from './live-day-probes.mjs';

const ids = state => state.dnr.map(rule => rule.id).sort((a, b) => a - b);
const rules = () => [35, 36].map(id => ({ id,
  blockURL: id === 35 ? 'live-day-usage.bd-e2e.test' : 'live-day-spent.bd-e2e.test',
  redirectURL: '', category: 'social', isWhitelist: false, assignments: [assignment('list-1')] }));
const readProbe = e => inBackground(e, view => ({ token: view.__bdLiveDay.token,
  gate: view.__bdLiveDay.gate, events: view.__bdLiveDay.events }));

async function backgroundTimezone(e, timezone) {
  await e.driver.setContext(firefox.Context.CHROME);
  try { return await e.driver.executeScript(setBackgroundTimezone, { id: e.id, timezone }); }
  finally { await e.driver.setContext(firefox.Context.CONTENT); }
}

async function timezone(e, offset) {
  await e.command('emulation.setTimezoneOverride', { timezone: offset, userContexts: ['default'] });
  const native = await backgroundTimezone(e, offset === null ? '' : 'GMT' + offset);
  const clock = await e.backgroundClock();
  const page = await e.probe.evaluate(() => ({ now: Date.now(), offset: new Date().getTimezoneOffset(),
    date: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}` }));
  assert.equal(clock.nativeDate, true, 'native Date/Date.now retained');
  assert.equal(clock.date, page.date, 'background and readers have the same local day');
  assert.equal(clock.offset, page.offset, 'background and readers have the same timezone offset');
  assert.ok(Math.abs(clock.now - Date.now()) < 2000, 'real wall clock was not advanced');
  return { ...clock, native };
}

async function startUsage(e, label) {
  const page = await e.newPage('http://live-day-usage.bd-e2e.test/' + label);
  await page.front();
  await equalEventually(() => page.evaluate(() => ({ visible: document.visibilityState,
    focused: document.hasFocus(), title: document.querySelector('h1')?.textContent })),
  { visible: 'visible', focused: true, title: 'BD E2E fixture' }, 'actual foreground fixture');
  await poll(() => e.state(), state => state.dailyRuleUsage.lastSample?.assignmentKeys.includes('35:list-1'),
    'real foreground accounting active');
  await delay(2200);
  return page;
}

async function beginMove(e, options, label) {
  const before = await e.state();
  await inBackground(e, (view, label) => { view.__bdLiveDay.gate = { label, entered: false }; }, label);
  await options.evaluate(message => {
    window.__bdLiveMove = { pending: true };
    browser.runtime.sendMessage(message).then(response => { window.__bdLiveMove = { response }; },
      error => { window.__bdLiveMove = { error: String(error) }; });
  }, { type: 'rules:deleteList', payload: { listId: 'list-1',
    expectedGeneration: before.rulesGeneration ?? null,
    expectedListRevision: before.ruleListRevisions?.['list-1'] ?? null } });
  const held = await poll(() => readProbe(e), value => value.gate?.entered, 'native journal commit held after durable write');
  assert.ok(held.gate.stack.includes('dailyLimitManager.js'), 'production journal writer reached');
  const durable = await e.state();
  assert.equal(durable.activeRuleListId, 'general');
  assert.deepEqual(durable.rules.map(rule => rule.assignments[0].listId), ['general', 'general']);
  assert.equal(durable.pendingDailyUsageRemaps.length, 2);
  assert.deepEqual(durable.dailyRuleUsage.lastSample.assignmentKeys, ['35:list-1'], 'old active sample is still durable');
  assert.equal(durable.dailyRuleUsage.usageSeconds['36:list-1'], 840);
  return { before, held: held.gate, durable };
}

async function finishMove(e, options) {
  await inBackground(e, view => view.__bdLiveDay.release());
  const result = await poll(() => options.evaluate(() => window.__bdLiveMove), value => !value.pending, 'native move response');
  assert.equal(result.response?.success, true, JSON.stringify(result));
  await equalEventually(async () => (await e.state()).pendingDailyUsageRemaps, [], 'native journal consumed');
}

function assertFreshHistory(events, since, date) {
  const writes = events.slice(since).filter(event => event.type === 'usage-write-called');
  assert.ok(writes.length > 0, 'observe production usage writes after day transition');
  for (const write of writes) {
    assert.equal(write.values.date, date, 'no delayed write restores an old day key');
    assert.equal(write.values.usageSeconds['36:general'] ?? 0, 0, 'old exhausted budget never moves into the new day');
    assert.equal(write.values.usageSeconds['36:list-1'] ?? 0, 0);
    assert.equal(write.values.usageSeconds['35:list-1'] ?? 0, 0, 'old assignment never resurrects');
    assert.ok((write.values.usageSeconds['35:general'] ?? 0) < 15, 'old foreground budget is not charged into the new day');
  }
}

async function closeNewSegment(e, page, options, date) {
  await poll(() => e.state(), state => state.dailyRuleUsage.date === date &&
    state.dailyRuleUsage.lastSample?.assignmentKeys.includes('35:general'), 'new-day native segment starts');
  await delay(2200); await options.front();
  const state = await poll(() => e.state(), state => state.dailyRuleUsage.date === date &&
    state.dailyRuleUsage.lastSample?.assignmentKeys.length === 0 &&
    state.dailyRuleUsage.usageSeconds['35:general'] > 0, 'new-day foreground segment closes');
  assert.ok(state.dailyRuleUsage.usageSeconds['35:general'] < 15);
  assert.equal(state.dailyRuleUsage.usageSeconds['36:general'] ?? 0, 0);
  assert.equal(state.dailyRuleUsage.usageSeconds['35:list-1'] ?? 0, 0);
  assert.deepEqual(state.pendingDailyUsageRemaps, []);
  assert.deepEqual(ids(state), []);
  assert.equal(await page.url(), 'http://live-day-usage.bd-e2e.test/transition');
  return state;
}

export const liveDayScenarios = [{ id: '40', title: 'live day change during a native durable remap wait clears old budget and active sample without restart',
  async run(e) {
    const evidence = e.result.liveDay = { processId: e.result.browser['moz:processID'],
      profile: e.result.browser['moz:profile'], mechanism: 'native Gecko BrowsingContext.timezoneOverride + BiDi reader timezone' };
    let installed = false;
    const original = await backgroundTimezone(e, '');
    try {
      evidence.initialClock = await timezone(e, '-12:00');
      assert.equal(evidence.initialClock.offset, 720);
      await inBackground(e, installLiveDayProbe); installed = true;
      evidence.token = (await readProbe(e)).token;
      // Positive native control: the same API wait within one day must retain
      // both budgets and remap the real active sample before the main case.
      await e.seed({ rules: rules(), active: 'list-1', usage: { '35:list-1': 120, '36:list-1': 840 } });
      const controlOptions = await e.openOptions(); await e.reconcile(controlOptions);
      await equalEventually(async () => ids(await e.state()), [36], 'old exhausted budget blocks');
      await startUsage(e, 'control');
      evidence.controlMove = await beginMove(e, controlOptions, 'same-day-control');
      await finishMove(e, controlOptions);
      await controlOptions.front();
      const control = await poll(() => e.state(), state => state.dailyRuleUsage.usageSeconds['35:general'] >= 120 &&
        state.dailyRuleUsage.usageSeconds['36:general'] === 840 && state.dailyRuleUsage.lastSample?.assignmentKeys.length === 0,
      'same-day move preserves native budgets');
      assert.equal(control.dailyRuleUsage.date, evidence.initialClock.date);
      assert.deepEqual(ids(control), [36]); evidence.controlState = control;

      await e.seed({ rules: rules(), active: 'list-1', usage: { '35:list-1': 120, '36:list-1': 840 } });
      const options = await e.openOptions(); await e.reconcile(options);
      await equalEventually(async () => ids(await e.state()), [36], 'main fixture old exhausted budget blocks');
      const page = await startUsage(e, 'transition');
      evidence.move = await beginMove(e, options, 'live-day-change');
      const since = (await readProbe(e)).events.length;
      e.phase = 'live-day-native-transition';
      evidence.changedClock = await timezone(e, '+12:00');
      assert.equal(evidence.changedClock.offset, -720);
      assert.notEqual(evidence.changedClock.date, evidence.initialClock.date);
      assert.equal((await readProbe(e)).token, evidence.token, 'same live background global');
      assert.equal(evidence.changedClock.native.context, evidence.initialClock.native.context, 'same hidden background context');
      await finishMove(e, options);
      const recovered = await e.state();
      assert.equal(recovered.dailyRuleUsage.date, evidence.changedClock.date);
      assert.equal(recovered.dailyRuleUsage.usageSeconds['36:general'] ?? 0, 0,
        'old exhausted budget is cleared after native journal recovery');
      await equalEventually(async () => ids(await e.state()), [], 'native recovery clears exhausted DNR after day change');
      evidence.newDayState = await closeNewSegment(e, page, options, evidence.changedClock.date);
      assertFreshHistory((await readProbe(e)).events, since, evidence.changedClock.date);
      const reopenedOptions = await e.openOptions(); const popup = await e.openPopup();
      for (const reader of [options, reopenedOptions, popup]) {
        await poll(() => reader.evaluate(() => [...document.querySelectorAll('.daily-limit-status, .rule-daily-limit-popup')]
          .map(node => ({ reached: node.classList.contains('limit-reached'), text: node.textContent }))),
        value => value.length === 2 && value.every(row => !row.reached) && value.some(row => /^0\s*\/\s*10/.test(row.text)),
        'native Options/Popup readers show cleared daily budgets');
      }
      const allowed = await e.newPage('http://live-day-spent.bd-e2e.test/cleared');
      await equalEventually(() => allowed.url(), 'http://live-day-spent.bd-e2e.test/cleared', 'formerly exhausted URL is actually allowed');

      const abaSince = (await readProbe(e)).events.length;
      evidence.returnedClock = await timezone(e, '-12:00');
      assert.equal(evidence.returnedClock.date, evidence.initialClock.date);
      await page.front();
      evidence.returnedState = await closeNewSegment(e, page, options, evidence.returnedClock.date);
      assertFreshHistory((await readProbe(e)).events, abaSince, evidence.returnedClock.date);
      evidence.observed = await readProbe(e);
      assert.equal(evidence.observed.token, evidence.token);
      assert.equal((await e.driver.getCapabilities()).get('moz:processID'), evidence.processId);
      assert.equal((await e.driver.getCapabilities()).get('moz:profile'), evidence.profile);
      assert.equal(e.result.launches.length, 1, 'no browser restart');
    } finally {
      if (installed) {
        evidence.finalProbe = await readProbe(e);
        await inBackground(e, view => view.__bdLiveDay.restore());
      }
      await e.command('emulation.setTimezoneOverride', { timezone: null, userContexts: ['default'] });
      await backgroundTimezone(e, original.before);
      await writeFile(path.join(e.config.output, 'native-live-day.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
  }
}];
