import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import firefox from 'selenium-webdriver/firefox.js';
import { dailyRule, SITE, poll, equalEventually } from './fixtures.mjs';
import { installIdleObserver, readIdleObserver, readColdState, removeIdleObserver } from './idle-probes.mjs';
import { observeColdEventPage, assertMessageWake, assertMessageActivity } from './native-cold-message.mjs';
import { installColdActivityObserver, readColdActivityObserver, removeColdActivityObserver } from './cold-message-probes.mjs';
import { COLD_PAGE, COLD_SCHEDULE, coldMetadata, coldRequests, installColdCollector, injectColdSender,
  triggerColdMessages, assertColdReplies, assertColdState } from './cold-message.mjs';

async function parent(e, fn) {
  await e.driver.setContext(firefox.Context.CHROME);
  try { return await e.driver.executeScript(fn, e.id); }
  finally { await e.driver.setContext(firefox.Context.CONTENT); }
}
const ids = state => state.dnr.map(rule => rule.id).sort((a, b) => a - b);

export const coldMessageScenarios = [{ id: '43',
  title: 'first content messages cold-wake the event page with persisted paid state, schedule and rule revisions',
  async run(e) {
    const crossList = { id: 22, blockURL: 'study-cold.bd-e2e.test', redirectURL: '', category: 'social',
      isWhitelist: false, assignments: [{ listId: 'list-1', disabledByUser: false,
        blockingMode: 'always', schedule: null, dailyLimit: null }] };
    await e.seed({ rules: [dailyRule(), crossList], usage: { '21:general': 840 } });
    const token = randomUUID();
    await e.writeLocal(coldMetadata(token));
    const options = await e.openOptions(); await e.reconcile(options);
    const popup = await e.openPopup();
    const alarms = () => e.probe.evaluate(() => browser.alarms.getAll());
    await poll(alarms, values => values.find(alarm => alarm.name === 'check_pro_expiry')?.scheduledTime > Date.now() + 3_600_000,
      'fresh-install license alarm advanced', 45_000);
    await popup.fill('#focus-duration', '10'); await popup.click('#focus-hardcore-mode'); await popup.click('#start-focus-btn');
    await equalEventually(async () => ids(await e.state()), [21, 22], 'real manual Hardcore Focus blocks the inactive profile');
    await e.writeLocal({ focusSchedule: COLD_SCHEDULE });
    const before = await e.state();
    assert.equal(before.focusSession.focusActive && before.focusSession.isHardcore, true);
    assert.ok(before.rulesGeneration && before.ruleListRevisions['list-1'] && before.ruleListRevisions['list-2']);
    const requests = coldRequests(before, token);
    const evidence = e.result.coldMessage = { token, before, requests, extensionId: e.id, producerUrl: COLD_PAGE,
      processId: e.result.browser['moz:processID'], profile: e.result.browser['moz:profile'] };
    assert.deepEqual(await parent(e, installColdActivityObserver), { installed: true });
    try {
      // Positive controls prove logging is live before the cold negative checks.
      // This warm read occurs with the readers open, before the idle interval.
      const warmRequest = { type: 'focus_schedule_get', __bdColdWarmToken: token };
      const warmReply = await e.probe.evaluate(request => browser.runtime.sendMessage(request), warmRequest);
      assert.equal(warmReply.revision, COLD_SCHEDULE.revision);
      evidence.warmActivity = await poll(() => parent(e, readColdActivityObserver), value =>
        value.events.some(event => event.type === 'message' && event.payload?.__bdColdWarmToken === token),
      'native activity logged the genuine warm message', 5000);
      const warmMessages = evidence.warmActivity.events.filter(event => event.type === 'message' && event.payload?.__bdColdWarmToken === token);
      assert.equal(warmMessages.length, 1); assert.deepEqual(warmMessages[0].payload, warmRequest);
      assert.equal(warmMessages[0].extensionId, e.id); assert.equal(warmMessages[0].sender.id, e.id);
      assert.deepEqual(evidence.warmActivity.errors, []);
      const producer = await e.newPage(COLD_PAGE);
      await producer.evaluate(installColdCollector, { token, count: 5 });
      const injected = evidence.injected = await e.probe.evaluate(injectColdSender, { url: COLD_PAGE, token, requests });
      assert.deepEqual(injected.frames, [{ frameId: 0, result: { installed: true, count: 5 } }], 'real main-frame content script');
      await producer.front();
      evidence.warmActivity = await poll(() => parent(e, readColdActivityObserver), value =>
        value.events.some(event => event.type === 'alarm' && event.alarm.name === 'update_scheduled_rules') &&
        value.nativeAlarms.find(alarm => alarm.name === 'update_scheduled_rules')?.scheduledTime - Date.now() > 55_000,
      'observed genuine minute tick leaves a cold-message window', 65_000);
      assert.deepEqual(evidence.warmActivity.errors, []);
      await e.probe.evaluate(async token => {
        (await browser.runtime.getBackgroundPage()).__bdIdleGlobal = token;
        await browser.storage.session.set({ __bdIdleSession: token });
      }, token);
      const nativeAlarms = evidence.nativeAlarms = await alarms();
      const earliestAlarm = Math.min(...nativeAlarms.map(alarm => alarm.scheduledTime));
      evidence.activityMarker = (await parent(e, readColdActivityObserver)).sequence;
      assert.deepEqual(await parent(e, installIdleObserver), { idleTimeout: 30_000, idleTimeoutOverridden: false });
      try {
        e.phase = 'native-cold-message-idle';
        for (const handle of await e.driver.getAllWindowHandles()) {
          if (handle === producer.context) continue;
          await e.driver.switchTo().window(handle); await e.driver.close();
        }
        await e.driver.switchTo().window(producer.context);
        e.probe = null; e.options = [];
        await observeColdEventPage({ read: () => parent(e, readIdleObserver), closedAt: Date.now(),
          processId: evidence.processId, profile: evidence.profile, producerUrl: COLD_PAGE, earliestAlarm, evidence });
        evidence.stoppedState = await parent(e, readColdState);
        assert.deepEqual(evidence.stoppedState.focusSession, before.focusSession, 'Focus remains live while the event page is stopped');
        e.phase = 'first-native-cold-message';
        // This one BiDi evaluation targets the ordinary HTTP page. Only its
        // injected content script sends runtime requests; no getBackgroundPage,
        // reopened UI, readiness ping or corrective message precedes them.
        const packet = evidence.firstReplies = await producer.evaluate(triggerColdMessages, token);
        assertColdReplies(packet, before, earliestAlarm);
        evidence.nativeActivity = await poll(() => parent(e, readColdActivityObserver), value =>
          value.events.filter(event => event.sequence > evidence.activityMarker && event.type === 'message' && event.sender?.url === COLD_PAGE).length >= 5,
        'native activity logged the five first content callbacks', 5000);
        evidence.nativeMessages = assertMessageActivity(evidence.nativeActivity, evidence, packet);
        evidence.wake = await parent(e, readIdleObserver);
        assertMessageWake(evidence.wake, evidence, packet);
        const after = evidence.coldState = await parent(e, readColdState);
        assertColdState(after, before);
        assert.deepEqual(after.session, { __bdIdleSession: token });
        // Only now open readers and observe the new background global.
        e.phase = 'cold-message-ui';
        e.probe = await e.openPopup();
        evidence.restoredIdentity = await e.probe.evaluate(async () => ({
          global: (await browser.runtime.getBackgroundPage()).__bdIdleGlobal ?? null,
          session: (await browser.storage.session.get('__bdIdleSession')).__bdIdleSession }));
        assert.deepEqual(evidence.restoredIdentity, { global: null, session: token });
        assert.deepEqual((await e.state()).credentials, before.credentials);
        const restoredOptions = await e.openOptions();
        await equalEventually(() => restoredOptions.evaluate(() => getComputedStyle(document.querySelector('#focus-session-banner')).display !== 'none'), true,
          'Options shows preserved Focus');
        await equalEventually(() => e.probe.evaluate(() => getComputedStyle(document.querySelector('#focus-active-view')).display !== 'none'), true,
          'Popup reader shows preserved Focus');
        await restoredOptions.hasClass('tr[data-rule-id="21"] .daily-limit-status', 'limit-reached');
        await e.assertBlocked(`${SITE}/cold-message-budget`, 'focus');
        await e.assertBlocked('http://study-cold.bd-e2e.test/cold-message-focus', 'focus');
      } finally {
        try { evidence.finalObservation = await parent(e, readIdleObserver); }
        finally {
          await parent(e, removeIdleObserver);
        }
      }
    } finally {
      try { evidence.finalActivity = await parent(e, readColdActivityObserver); }
      finally {
        await parent(e, removeColdActivityObserver);
        await writeFile(path.join(e.config.output, 'native-cold-message.json'), JSON.stringify(evidence, null, 2) + '\n');
      }
    }
  }
}];
