import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inBackground } from './scheduled-expiry-probes.mjs';
import { installMutationProbe, readMutationProbe, releaseMutationProbe, restoreMutationProbe, beginMutation } from './mutation-probes.mjs';
import { assertMutationNavigation, assertSentinelHistory } from './mutation-navigation.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check, label) {
  const deadline = Date.now() + 15_000;
  let value;
  do { value = await read(); if (check(value)) return value; await pause(50); } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const assignment = (listId, daily = false) => ({ listId, disabledByUser: false,
  blockingMode: daily ? 'daily_limit' : 'always', schedule: null, dailyLimit: daily ? { minutes: 10 } : null });
const rule = (id, blockURL, lists = ['general'], daily = false) => ({ id, blockURL, redirectURL: '',
  category: 'social', isWhitelist: false, assignments: lists.map(list => assignment(list, daily)) });
const revision = (state, id) => ({ expectedGeneration: state.rulesGeneration ?? null,
  expectedRevision: state.ruleRevisions?.[id] ?? null, expectedListRevisions: state.ruleListRevisions || {} });
const probeState = e => inBackground(e, readMutationProbe);

async function save(e, label, value) {
  if (e.testInfo) await e.testInfo.attach(label, { contentType: 'application/json', body: JSON.stringify(value, null, 2) });
  else (e.result.mutationEvidence ||= []).push({ label, value });
}

export function assertInterruptedRemap(state, { phase, token, splitHost }) {
  assert.equal(state.__bdInterruptionMarker, token, 'checkpoint belongs to this isolated profile');
  const split = state.rules.find(item => item.blockURL === splitHost);
  assert.ok(split && split.id !== 21 && split.id !== 24, 'real production edit split the shared rule');
  assert.deepEqual(split.assignments, [assignment('list-1', true)]);
  assert.deepEqual(state.rules.find(item => item.id === 21).assignments, [assignment('general', true)]);
  const newKey = `${split.id}:list-1`;
  const usage = { '21:general': 100, '24:general': 77 };
  if (phase === 'journal') {
    assert.deepEqual(state.pendingDailyUsageRemaps, [{ oldRuleId: 21, oldListId: 'list-1', newRuleId: split.id, newListId: 'list-1' }]);
    usage['21:list-1'] = 840;
  } else {
    assert.equal(phase, 'remapped');
    assert.deepEqual(state.pendingDailyUsageRemaps, []);
    usage[newKey] = 840;
  }
  assert.deepEqual(state.dailyRuleUsage.usageSeconds, usage, 'exact native usage at the interruption point');
  return { id: split.id, newKey, usage: { '21:general': 100, '24:general': 77, [newKey]: 840 } };
}

export function assertRecoveredRemap(state, checkpoint, expected) {
  for (const key of ['rules', 'ruleLists', 'activeRuleListId', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions', 'credentials']) {
    assert.deepEqual(state[key], checkpoint[key], `${key} survives interrupted production mutation`);
  }
  assert.deepEqual(state.pendingDailyUsageRemaps, [], 'recovery consumed the durable journal');
  assert.deepEqual(state.dailyRuleUsage.usageSeconds, expected.usage, 'spent and unrelated budgets survive exactly once');
  assert.deepEqual(state.dnr.map(item => item.id).sort((a, b) => a - b), [expected.id], 'native DNR enforces the remapped active assignment');
}

async function interruptedMutation(e, phase) {
  const token = randomUUID(), splitHost = `split-${token}.bd-e2e.test`;
  const report = { schemaVersion: 1, phase, token, stage: 'prepare genuine shared-rule edit', scope: 'Linux owned browser SIGKILL after a native write; not power-loss durability or automatic idle unload' };
  let installed = false;
  try {
    await e.seed({ rules: [rule(21, 'usage.bd-e2e.test', ['general', 'list-1'], true),
      rule(24, 'unrelated-mutation.bd-e2e.test', ['general'], true)], active: 'list-1',
      usage: { '21:general': 100, '21:list-1': 840, '24:general': 77 } });
    await e.writeLocal({ __bdInterruptionMarker: token });
    const options = await e.openOptions(); await e.reconcile(options);
    await e.assertBlocked('http://usage.bd-e2e.test/before-interruption', 'daily_limit');
    const before = await e.state();
    await inBackground(e, installMutationProbe, { phase, token, expectedHost: splitHost }); installed = true;
    await options.evaluate(beginMutation, { type: 'rules:update', payload: {
      ruleId: 21, assignmentListId: 'list-1', blockURL: splitHost, redirectURL: '', category: 'social',
      assignment: assignment('list-1', true), ...revision(before, 21)
    } });
    report.stage = 'native storage result held';
    report.probe = await until(() => probeState(e), value => value.ready, 'production mutation reached the selected native storage checkpoint');
    assert.equal(report.probe.token, token);
    assert.equal(report.probe.overflow, false);
    report.checkpoint = await e.state();
    const expected = assertInterruptedRemap({ ...report.checkpoint,
      __bdInterruptionMarker: report.probe.entered.local.__bdInterruptionMarker }, { phase, token, splitHost });
    assert.equal((await options.evaluate(() => globalThis.__bdMutationReply)).pending, true, 'the production request has not replied');
    await save(e, `interrupted-mutation-${phase}-before-kill`, report);
    report.stage = 'interrupt owned process and relaunch the same profile';
    report.interruption = await e.interruptAndRestart(); installed = false;
    assert.equal(report.interruption.signal, 'SIGKILL');
    assert.notEqual(report.interruption.beforePid, report.interruption.afterPid, 'recovery uses a new browser process');
    const marker = await inBackground(e, async view =>
      (await (view.browser || view.chrome).storage.local.get('__bdInterruptionMarker')).__bdInterruptionMarker);
    assert.equal(marker, token, 'the same persistent profile recovered without reseeding');
    report.recovered = await until(() => e.state(), value => {
      try { assertRecoveredRemap(value, report.checkpoint, expected); return true; } catch { return false; }
    }, 'automatic startup recovery completed without a corrective rules intent');
    assertRecoveredRemap(report.recovered, report.checkpoint, expected);
    const reader = await e.openOptions();
    const popup = await e.openPopup();
    for (const page of [reader, popup]) await until(() => page.evaluate(id => {
      const row = document.querySelector(`[data-rule-id="${id}"]`);
      const status = row?.querySelector('.daily-limit-status, .rule-daily-limit-popup');
      return { present: Boolean(row), exhausted: Boolean(status?.classList.contains('limit-reached')) };
    }, expected.id), value => value.present && value.exhausted, 'Options and Popup show the recovered exhausted assignment');
    await e.assertBlocked(`http://${splitHost}/after-interruption`, 'daily_limit');
    report.stage = 'second restart proves idempotent recovery';
    await e.restart();
    report.repeated = await until(() => e.state(), value => {
      try { assertRecoveredRemap(value, report.checkpoint, expected); return true; } catch { return false; }
    }, 'a second process start cannot replay the budget transfer');
    assertRecoveredRemap(report.repeated, report.checkpoint, expected);
    await e.assertBlocked(`http://${splitHost}/after-second-restart`, 'daily_limit');
    report.stage = 'complete';
  } catch (error) {
    report.error = String(error); throw error;
  } finally {
    report.interruption ??= e.interruptionEvidence;
    let cleanupError;
    if (installed) try { await inBackground(e, restoreMutationProbe); }
    catch (error) { report.probeCleanupError = String(error); cleanupError = error; }
    await save(e, `interrupted-mutation-${phase}`, report);
    if (cleanupError && report.stage === 'complete') throw cleanupError;
  }
}

async function mutationContinuity(e) {
  const probe = e.mutationNavigation;
  assert.ok(probe, 'native HTTP navigation fixture was prepared before launch');
  const report = { schemaVersion: 1, scope: 'sampled native main-frame navigations and every observed DNR commit during three controlled production intents', operations: [], stage: 'HTTP positive controls' };
  let installed = false;
  let watching;
  try {
    const page = await e.newPage();
    const extensionOrigin = e.worker ? `chrome-extension://${e.id}` : e.baseUrl;
    const sample = (host, blocked, phase) => probe.sample(page, host, { blocked, phase, extensionOrigin });
    for (const host of Object.values(probe.hosts).filter(host => host !== probe.hosts.control)) await sample(host, false, 'before-rule-setup');
    const sentinel = rule(90, probe.hosts.sentinel, ['general', 'list-1']);
    await e.seed({ rules: [sentinel, rule(91, probe.hosts.old)] });
    const options = await e.openOptions(); await e.reconcile(options);
    const cases = [
      { name: 'edit', from: probe.hosts.old, to: probe.hosts.edited, build: state => ({ type: 'rules:update', payload: {
        ruleId: 91, assignmentListId: 'general', blockURL: probe.hosts.edited, redirectURL: '',
        assignment: assignment('general'), ...revision(state, 91) } }) },
      { name: 'import', from: probe.hosts.edited, to: probe.hosts.imported, build: state => ({ type: 'rules:replaceAll', payload: {
        rules: [sentinel, rule(92, probe.hosts.imported), rule(93, probe.hosts.study, ['list-1'])],
        ruleLists: state.ruleLists, activeRuleListId: 'general' } }) },
      { name: 'activate-list', from: probe.hosts.imported, to: probe.hosts.study, build: state => ({ type: 'rules:activateList', payload: {
        listId: 'list-1', expectedGeneration: state.rulesGeneration ?? null,
        expectedListRevision: state.ruleListRevisions?.['list-1'] ?? null } }) }
    ];
    for (const operation of cases) {
      report.stage = operation.name;
      const record = { name: operation.name, from: operation.from, to: operation.to }; report.operations.push(record);
      await sample(probe.hosts.sentinel, true, `${operation.name}:before`);
      await sample(operation.from, true, `${operation.name}:before-old`);
      await sample(operation.to, false, `${operation.name}:before-new`);
      const before = await e.state();
      await inBackground(e, installMutationProbe, { phase: 'dnr', token: probe.token, expectedHost: operation.to }); installed = true;
      await options.evaluate(beginMutation, operation.build(before));
      await until(() => probeState(e), value => value.ready, 'production DNR invocation is held');
      await sample(probe.hosts.sentinel, true, `${operation.name}:before-native-commit`);
      // This real navigation runs concurrently with release of the native DNR
      // call. Any rejection is immediately consumed, then asserted below.
      watching = sample(probe.hosts.sentinel, true, `${operation.name}:across-native-commit`)
        .then(value => ({ value }), error => ({ error }));
      await inBackground(e, releaseMutationProbe);
      await until(() => probeState(e), value => Boolean(value.committed), 'genuine native DNR update committed');
      const observed = await watching; watching = null;
      if (observed.error) throw observed.error;
      assert.equal((await options.evaluate(() => globalThis.__bdMutationReply)).pending, true, 'native commit precedes the production acknowledgement');
      await sample(probe.hosts.sentinel, true, `${operation.name}:after-native-commit`);
      await sample(operation.from, false, `${operation.name}:after-native-old`);
      await sample(operation.to, true, `${operation.name}:after-native-new`);
      await inBackground(e, releaseMutationProbe);
      record.reply = await until(() => options.evaluate(() => globalThis.__bdMutationReply), value => !value.pending, 'production mutation replied');
      assert.equal(record.reply.value?.success, true, JSON.stringify(record.reply));
      assert.notEqual(record.reply.value.syncPending, true, 'the successful operation installed its DNR rules');
      await sample(probe.hosts.sentinel, true, `${operation.name}:after-reply`);
      await sample(operation.to, true, `${operation.name}:acknowledged-new`);
      record.probe = await probeState(e);
      assertSentinelHistory(record.probe, probe.hosts.sentinel);
      await inBackground(e, restoreMutationProbe); installed = false;
    }
    assertMutationNavigation(probe.snapshot());
    report.stage = 'complete';
  } catch (error) {
    report.error = String(error); throw error;
  } finally {
    // Release the gate even when a navigation failed; do not leave an owned
    // production request pending while the fixture gathers final diagnostics.
    let cleanupError;
    if (installed) try { await inBackground(e, restoreMutationProbe); }
    catch (error) { report.probeCleanupError = String(error); cleanupError = error; }
    if (watching) await watching;
    report.navigation = probe.snapshot();
    await save(e, 'native-mutation-continuity', report);
    if (cleanupError && report.stage === 'complete') throw cleanupError;
  }
}

export const interruptedMutationScenarios = ['journal', 'remapped'].map((phase, index) => ({
  id: String(70 + index), persistent: true, nativeDesktop: true,
  title: `native process interruption after ${phase} write recovers the committed split and spent budget exactly once`,
  run: e => interruptedMutation(e, phase)
}));
export const mutationContinuityScenario = { id: '72',
  title: 'native navigation and DNR commit history preserve an unchanged block through edit, import and profile activation',
  run: mutationContinuity };
