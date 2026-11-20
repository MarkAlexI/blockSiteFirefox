import assert from 'node:assert/strict';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, condition, label) {
  const deadline = Date.now() + 20_000;
  let value;
  do { value = await read(); if (condition(value)) return value; await wait(80); } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const click = (page, selector) => page.locator ? page.locator(selector).click() : page.click(selector);
const fill = (page, selector, value) => page.locator ? page.locator(selector).fill(value) : page.fill(selector, value);
const select = (page, selector, value) => page.locator ? page.locator(selector).selectOption(value) : page.select(selector, value);
const command = (page, message) => page.evaluate(async message => (globalThis.browser || chrome).runtime.sendMessage(message), message);
const state = e => e.state(['pomodoroSession', 'statistics']);
const rule = (id, mode) => ({ id, blockURL: `pomodoro-${id}.bd-e2e.test`, redirectURL: '', category: 'social', isWhitelist: false,
  assignments: [{ listId: 'general', disabledByUser: false, blockingMode: mode, schedule: null,
    dailyLimit: mode === 'daily_limit' ? { minutes: 1 } : null }] });

async function popup(e) {
  const page = await e.openPopup();
  await until(() => page.evaluate(() => !document.getElementById('focus-session-section').classList.contains('hidden')),
    Boolean, 'Focus controls ready');
  return page;
}

async function start(page, { hardcore = false, auto = false, rounds = 3 } = {}) {
  await select(page, '#focus-cycle-type', 'pomodoro');
  await fill(page, '#focus-duration', '1');
  await fill(page, '#pomodoro-breakMinutes', '1');
  await fill(page, '#pomodoro-rounds', String(rounds));
  if (hardcore) await click(page, '#focus-hardcore-mode');
  if (auto) await click(page, '#pomodoro-autoContinue');
  await click(page, '#start-focus-btn');
}

// Change only the saved fixture deadline, then let the real browser deliver its
// real alarm to production code. No Date, timer, alarm API or handler is mocked.
async function finishPhase(page, phase) {
  await until(() => page.evaluate(() => !document.getElementById('focus-controls').hasAttribute('aria-busy')), Boolean, 'Focus action finished before changing the fixture deadline');
  await page.evaluate(async phase => {
    const api = globalThis.browser || chrome;
    const stored = await api.storage.local.get(['focusSession', 'pomodoroSession']);
    const end = Date.now() + 1500;
    const cycle = { ...stored.pomodoroSession, phaseEndTime: end };
    await api.storage.local.set({ pomodoroSession: cycle,
      ...(phase === 'work' ? { focusSession: { ...stored.focusSession, focusEndTime: end } } : {}) });
    await api.alarms.create(phase === 'work' ? 'end_focus_session' : 'pomodoro_break_end', { when: end });
  }, phase);
}

export const pomodoroScenarios = [{
  id: '93', title: 'Pomodoro manual cycles retain ordinary blocking and Daily Limits during native work and break transitions',
  async run(e) {
    const rules = [rule(201, 'always'), rule(202, 'daily_limit')];
    await e.seed({ rules, usage: { '202:general': 60 } });
    const page = await popup(e);
    await start(page, { rounds: 2 });
    const first = await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'Pomodoro work started');
    assert.equal(first.pomodoroSession.autoContinue, false);
    await finishPhase(page, 'work');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'break' && s.focusSession.focusActive === false, 'native work completion');
    await e.assertBlocked('http://pomodoro-201.bd-e2e.test/');
    await e.assertBlocked('http://pomodoro-202.bd-e2e.test/');
    assert.equal((await state(e)).dailyRuleUsage.usageSeconds['202:general'], 60);
    assert.deepEqual((await state(e)).rules, rules);
    await finishPhase(page, 'break');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'ready', 'break ends without automatic work');
    await until(() => page.evaluate(() => !document.getElementById('pomodoro-next').hidden), Boolean, 'Continue visible');
    await click(page, '#pomodoro-next');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'work' && s.pomodoroSession.completedRounds === 1, 'second work interval');
    await finishPhase(page, 'work');
    const done = await until(() => state(e), s => s.pomodoroSession === null && !s.focusSession.focusActive && s.statistics?.successfulFocusSessions === 2, 'finite cycle completion and statistics');
    assert.equal(done.statistics.successfulFocusSessions, 2);
    assert.equal(done.dailyRuleUsage.usageSeconds['202:general'], 60);
    assert.deepEqual(done.rules, rules);
    assert.equal((await command(page, { type: 'continue_pomodoro', id: first.pomodoroSession.id })).success, false);
  }
}, {
  id: '94', title: 'Pomodoro automatic continuation preserves Hardcore and rejects direct Stop or replacement messages',
  async run(e) {
    await e.seed({ rules: [rule(201, 'always')] });
    const page = await popup(e);
    await start(page, { hardcore: true, auto: true });
    const first = await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'Hardcore work started');
    for (const message of [{ type: 'stop_focus_session' }, { type: 'stop_pomodoro', id: first.pomodoroSession.id },
      { type: 'start_focus_session', duration: 25 }, { type: 'start_pomodoro', config: {} }]) {
      assert.equal((await command(page, message)).success, false);
    }
    assert.deepEqual((await state(e)).focusSession, first.focusSession);
    await finishPhase(page, 'work');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'break', 'Hardcore interval ends');
    await finishPhase(page, 'break');
    const second = await until(() => state(e), s => s.pomodoroSession?.phase === 'work' && s.pomodoroSession.completedRounds === 1, 'automatic next interval');
    assert.equal(second.focusSession.isHardcore, true);
    assert.equal(second.statistics.successfulFocusSessions, 1);
    await finishPhase(page, 'work');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'break', 'second break');
    await click(page, '#pomodoro-stop');
    await until(() => state(e), s => s.pomodoroSession === null, 'End cycle during break');
    assert.equal((await state(e)).focusSession.focusActive, false);
  }
}, {
  id: '95', title: 'Pomodoro restart restores waiting after an overdue break and Free retains the complete 25/5 preset', persistent: true,
  async run(e) {
    await e.seed({ rules: [rule(201, 'always')] });
    let page = await popup(e);
    await start(page, { hardcore: true, auto: true });
    const work = await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'work started');
    await e.writeLocal({ pomodoroSession: { ...work.pomodoroSession, phase: 'break', completedRounds: 1,
      phaseEndTime: Date.now() - 8 * 3600_000 },
      focusSession: { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' } });
    await e.restart();
    const restored = await until(() => state(e), s => s.pomodoroSession?.phase === 'ready', 'overdue break restored');
    assert.equal(restored.pomodoroSession.completedRounds, 1);
    assert.equal(restored.focusSession.focusActive, false);
    assert.equal(restored.statistics?.successfulFocusSessions || 0, 0);
    page = await popup(e);
    await click(page, '#pomodoro-stop');
    await until(() => state(e), s => s.pomodoroSession === null, 'restored cycle stopped');
    assert.equal((await command(page, { type: 'logout_pro' })).success, true);
    await until(() => page.evaluate(() => document.getElementById('pomodoro-autoContinue').disabled && !document.getElementById('pomodoro-autoContinue').checked), Boolean, 'Pro loss clears and disables automatic continuation');
    await e.seed({ pro: false, rules: [rule(201, 'always')] });
    page = await popup(e);
    await select(page, '#focus-cycle-type', 'pomodoro');
    assert.deepEqual(await page.evaluate(() => ({
      work: document.getElementById('focus-duration').value,
      rest: document.getElementById('pomodoro-breakMinutes').value,
      locked: document.getElementById('pomodoro-breakMinutes').disabled,
      auto: document.getElementById('pomodoro-autoContinue').checked,
      autoLocked: document.getElementById('pomodoro-autoContinue').disabled
    })), { work: '25', rest: '5', locked: true, auto: false, autoLocked: true });
    assert.equal((await command(page, { type: 'start_pomodoro', config: { workMinutes: 1 } })).code, 'pro_required');
    assert.equal((await command(page, { type: 'start_pomodoro', config: { autoContinue: true } })).code, 'pro_required');
    await click(page, '#start-focus-btn');
    const free = await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'Free cycle started');
    assert.equal(free.pomodoroSession.workMinutes, 25);
    assert.equal(free.pomodoroSession.breakMinutes, 5);
    assert.equal(free.pomodoroSession.autoContinue, false);
    await until(() => page.evaluate(() => !document.getElementById('focus-controls').hasAttribute('aria-busy') && !document.getElementById('stop-focus-btn').hidden), Boolean, 'Stop ready after Start reply');
    await click(page, '#stop-focus-btn');
    await until(() => state(e), s => s.pomodoroSession === null, 'Free Stop ends whole cycle');
  }
}];

pomodoroScenarios.push({
  id: '96', title: 'Pomodoro overdue native recovery waits without replay and Free controls retain the standard 25/5 cycle',
  async run(e) {
    await e.seed({ rules: [rule(201, 'always')] });
    let page = await popup(e);
    await start(page, { hardcore: true, auto: true });
    const work = await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'initial work');
    await page.evaluate(async cycle => {
      const api = globalThis.browser || chrome;
      await api.storage.local.set({ pomodoroSession: { ...cycle, phase: 'break', completedRounds: 1,
        phaseEndTime: Date.now() - 8 * 3600_000 },
        focusSession: { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' } });
      await api.alarms.create('update_scheduled_rules', { when: Date.now() + 1500, periodInMinutes: 1 });
    }, work.pomodoroSession);
    const ready = await until(() => state(e), s => s.pomodoroSession?.phase === 'ready', 'native overdue recovery');
    assert.equal(ready.pomodoroSession.completedRounds, 1);
    assert.equal(ready.focusSession.focusActive, false);
    assert.equal(ready.statistics?.successfulFocusSessions || 0, 0);
    assert.equal((await command(page, { type: 'continue_pomodoro', id: ready.pomodoroSession.id, completedRounds: 0 })).code, 'pomodoro_changed');
    await click(page, '#pomodoro-stop');
    await until(() => state(e), s => s.pomodoroSession === null, 'overdue cycle stopped');
    assert.equal((await command(page, { type: 'logout_pro' })).success, true);
    await until(() => page.evaluate(() => document.getElementById('pomodoro-autoContinue').disabled && !document.getElementById('pomodoro-autoContinue').checked), Boolean, 'Pro loss clears and disables automatic continuation');
    await e.seed({ pro: false, rules: [rule(201, 'always')] });
    page = await popup(e);
    await select(page, '#focus-cycle-type', 'pomodoro');
    assert.deepEqual(await page.evaluate(() => ({
      work: document.getElementById('focus-duration').value,
      rest: document.getElementById('pomodoro-breakMinutes').value,
      locked: document.getElementById('pomodoro-breakMinutes').disabled,
      auto: document.getElementById('pomodoro-autoContinue').checked,
      autoLocked: document.getElementById('pomodoro-autoContinue').disabled
    })), { work: '25', rest: '5', locked: true, auto: false, autoLocked: true });
    assert.equal((await command(page, { type: 'start_pomodoro', config: { workMinutes: 1 } })).code, 'pro_required');
    assert.equal((await command(page, { type: 'start_pomodoro', config: { autoContinue: true } })).code, 'pro_required');
    await click(page, '#start-focus-btn');
    const free = await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'Free work');
    assert.equal(free.pomodoroSession.workMinutes, 25);
    assert.equal(free.pomodoroSession.breakMinutes, 5);
    assert.equal(free.pomodoroSession.autoContinue, false);
    await finishPhase(page, 'work');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'break', 'Free work automatically opens its break');
    await finishPhase(page, 'break');
    const waiting = await until(() => state(e), s => s.pomodoroSession?.phase === 'ready', 'Free waits after its break');
    assert.equal(waiting.focusSession.focusActive, false);
    await click(page, '#pomodoro-next');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'work' && s.pomodoroSession.completedRounds === 1, 'Free manual continuation');
    await until(() => page.evaluate(() => !document.getElementById('focus-controls').hasAttribute('aria-busy') && !document.getElementById('stop-focus-btn').hidden), Boolean, 'Stop ready after Start reply');
    await click(page, '#stop-focus-btn');
    await until(() => state(e), s => s.pomodoroSession === null, 'Free Stop');
  }
});
