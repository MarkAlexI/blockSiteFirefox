import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import firefox from 'selenium-webdriver/firefox.js';
import { dailyRule, SITE, poll, equalEventually } from './fixtures.mjs';
import { installIdleObserver, readIdleObserver, readColdState, removeIdleObserver } from './idle-probes.mjs';
import { observeEventPageIdle } from './native-idle.mjs';

const ids = state => state.dnr.map(rule => rule.id).sort((a, b) => a - b);
async function parent(e, fn, input = e.id) {
  await e.driver.setContext(firefox.Context.CHROME);
  try { return await e.driver.executeScript(fn, input); }
  finally { await e.driver.setContext(firefox.Context.CONTENT); }
}

export const idleScenarios = [{ id: '39',
  title: 'automatic event-page idle unload and native Focus alarm wake preserve session, budget, UI and DNR',
  async run(e) {
    const crossList = { id: 22, blockURL: 'study-idle.bd-e2e.test', redirectURL: '', category: 'social',
      isWhitelist: false, assignments: [{ listId: 'list-1', disabledByUser: false,
        blockingMode: 'always', schedule: null, dailyLimit: null }] };
    await e.seed({ rules: [dailyRule(), crossList], usage: { '21:general': 840 } });
    const options = await e.openOptions();
    await e.reconcile(options);
    const popup = await e.openPopup(); // Reader tab; existing toolbar scenarios remain separate.
    await equalEventually(async () => ids(await e.state()), [21], 'exhausted daily budget blocks');
    const alarms = () => e.probe.evaluate(() => browser.alarms.getAll());
    await poll(alarms, values => values.find(alarm => alarm.name === 'check_pro_expiry')?.scheduledTime > Date.now() + 3_600_000,
      'fresh-install license alarm advanced', 45_000);
    await poll(alarms, values => {
      const remaining = values.find(alarm => alarm.name === 'update_scheduled_rules')?.scheduledTime - Date.now();
      return remaining >= 6000 && remaining <= 10_000;
    }, 'start Focus before a genuine minute tick', 65_000);
    await popup.fill('#focus-duration', '1');
    await popup.click('#start-focus-btn');
    await equalEventually(async () => ids(await e.state()), [21, 22], 'Focus includes the inactive profile');
    await equalEventually(() => popup.evaluate(() => document.querySelector('#focus-active-view').classList.contains('hidden')),
      false, 'Popup shows running Focus');
    await equalEventually(() => options.evaluate(() => document.querySelector('#focus-session-banner').classList.contains('hidden')),
      false, 'Options shows running Focus');
    await poll(alarms, values => values.find(alarm => alarm.name === 'update_scheduled_rules')?.scheduledTime - Date.now() > 50_000,
      'genuine minute tick completed', 20_000);
    const before = await e.state();
    assert.equal(before.focusSession.focusActive, true);
    assert.deepEqual(before.dailyRuleUsage.usageSeconds, { '21:general': 840 });
    assert.deepEqual(before.pendingDailyUsageRemaps, []);
    const token = randomUUID();
    await e.probe.evaluate(async token => {
      const view = await browser.runtime.getBackgroundPage();
      view.__bdIdleGlobal = token;
      await browser.storage.session.set({ __bdIdleSession: token });
    }, token);
    const nativeAlarms = await alarms();
    const alarm = nativeAlarms.find(item => item.name === 'end_focus_session');
    assert.equal(alarm?.scheduledTime, before.focusSession.focusEndTime, 'real Focus completion alarm');
    const evidence = e.result.idleWake = { processId: e.result.browser['moz:processID'],
      profile: e.result.browser['moz:profile'], token, nativeAlarms };
    const settings = await parent(e, installIdleObserver);
    assert.deepEqual(settings, { idleTimeout: 30_000, idleTimeoutOverridden: false }, 'unmodified native idle timeout');
    e.phase = 'native-idle-wake';
    try {
      const keeper = await e.newPage();
      await keeper.front();
      for (const handle of await e.driver.getAllWindowHandles()) {
        if (handle === keeper.context) continue;
        await e.driver.switchTo().window(handle); await e.driver.close();
      }
      await e.driver.switchTo().window(keeper.context);
      e.probe = null; e.options = [];
      evidence.keeper = keeper.context;
      const closedAt = Date.now();
      await observeEventPageIdle({ read: () => parent(e, readIdleObserver), closedAt,
        processId: evidence.processId, profile: evidence.profile, alarm,
        competingAlarms: nativeAlarms.filter(item => item.name !== alarm.name), evidence });
      // Native backends only: no getBackgroundPage, runtime intent or reopened
      // UI may repair the cold handler before this state is checked.
      const cold = await poll(() => parent(e, readColdState), state => !state.focusSession.focusActive &&
        JSON.stringify(ids(state)) === '[21]', 'cold alarm handler ended Focus and updated native DNR');
      evidence.coldState = cold;
      assert.deepEqual(cold.session, { __bdIdleSession: token }, 'native session storage survives unload');
      assert.deepEqual(cold.focusSession, { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' });
      for (const key of ['rules', 'ruleLists', 'activeRuleListId', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions']) {
        assert.deepEqual(cold[key], before[key], `${key} survives idle/wake`);
      }
      assert.deepEqual(cold.dailyRuleUsage.usageSeconds, { '21:general': 840 });
      assert.deepEqual(cold.pendingDailyUsageRemaps, []);
      assert.deepEqual(await e.driver.getAllWindowHandles(), [keeper.context], 'same keeper, no browser restart');
      assert.equal((await e.driver.getCapabilities()).get('moz:processID'), evidence.processId);
      assert.equal((await e.driver.getCapabilities()).get('moz:profile'), evidence.profile);
      e.phase = 'idle-wake-ui';
      e.probe = await e.openPopup();
      evidence.restoredIdentity = await e.probe.evaluate(async () => {
        const view = await browser.runtime.getBackgroundPage();
        return { global: view.__bdIdleGlobal ?? null,
          session: (await browser.storage.session.get('__bdIdleSession')).__bdIdleSession };
      });
      assert.deepEqual(evidence.restoredIdentity, { global: null, session: token }, 'new background global, preserved native session');
      const restoredAlarms = await alarms(); evidence.restoredAlarms = restoredAlarms;
      assert.equal(restoredAlarms.some(item => item.name === alarm.name), false, 'completed one-shot alarm removed');
      assert.ok(restoredAlarms.find(item => item.name === 'update_scheduled_rules')?.scheduledTime > alarm.scheduledTime);
      const after = await e.state(); assert.deepEqual(after.credentials, before.credentials);
      const restoredOptions = await e.openOptions();
      await equalEventually(() => restoredOptions.evaluate(() => getComputedStyle(document.querySelector('#focus-session-banner')).display),
        'none', 'Options shows completed Focus');
      await equalEventually(() => e.probe.evaluate(() => getComputedStyle(document.querySelector('#focus-active-view')).display),
        'none', 'Popup reader shows completed Focus');
      await equalEventually(() => e.probe.evaluate(() => getComputedStyle(document.querySelector('#focus-start-view')).display !== 'none'),
        true, 'Popup reader offers a new Focus');
      await restoredOptions.hasClass('tr[data-rule-id="21"] .daily-limit-status', 'limit-reached');
      await e.assertBlocked(`${SITE}/budget-after-wake`, 'daily_limit');
      const allowed = await e.newPage('http://study-idle.bd-e2e.test/after-stop');
      await equalEventually(() => allowed.url(), 'http://study-idle.bd-e2e.test/after-stop', 'inactive profile no longer blocks');
    } finally {
      try { evidence.finalObservation = await parent(e, readIdleObserver); }
      finally {
        await parent(e, removeIdleObserver);
        await writeFile(path.join(e.config.output, 'native-idle-wake.json'), JSON.stringify(evidence, null, 2) + '\n');
      }
    }
  }
}];
