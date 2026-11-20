import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  if (auto && !hardcore) await click(page, '#pomodoro-autoContinue');
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
    const cycle = { ...stored.pomodoroSession, phaseEndTime: end,
      ...(phase === 'work' && stored.pomodoroSession.isHardcore ? { workStartedAt: end - stored.pomodoroSession.workMinutes * 60_000 } : {}) };
    await api.storage.local.set({ pomodoroSession: cycle,
      ...(phase === 'work' ? { focusSession: { ...stored.focusSession, focusEndTime: end } } : {}) });
    await api.alarms.create(phase === 'work' ? 'end_focus_session' : 'pomodoro_break_end', { when: end });
  }, phase);
}


async function press(page, key) { return page.keyboard ? page.keyboard.press(key) : page.press(key); }
async function endPomodoro(page) {
  const selector = await page.evaluate(() => !document.getElementById('stop-focus-btn').hidden &&
    !document.getElementById('focus-active-view').hidden ? '#stop-focus-btn' : '#pomodoro-stop');
  await click(page, selector);
  await until(() => page.evaluate(() => document.getElementById('pomodoro-end-dialog').open), Boolean, 'End confirmation open');
  await click(page, '#pomodoro-end-dialog button[value="end"]');
}
async function expireHardcore(page, after = 1800) {
  await page.evaluate(async after => {
    const api = globalThis.browser || chrome;
    const { pomodoroSession } = await api.storage.local.get('pomodoroSession');
    const end = Date.now() + after;
    await api.storage.local.set({ pomodoroSession: { ...pomodoroSession, hardcoreEndTime: end } });
    await api.alarms.create('pomodoro_hardcore_end', { when: end });
  }, after);
}
async function capture(e, page, name) {
  const output = path.join(path.resolve(process.env.BD_E2E_RESULTS || 'test-results'), 'pomodoro-visual');
  await mkdir(output, { recursive: true });
  const file = path.join(output, name + '.png');
  if (page.front) await page.front(); else await page.bringToFront();
  await page.evaluate(async () => {
    const frame = document.getElementById('pomodoro-break-probe') || document.getElementById('pomodoro-responsive-probe');
    if (frame) {
      frame.scrollIntoView({ block: 'start' });
      frame.contentWindow.scrollTo(0, frame.contentDocument.getElementById('focus-session-section').offsetTop);
      await new Promise(resolve => frame.contentWindow.requestAnimationFrame(() => frame.contentWindow.requestAnimationFrame(resolve)));
    }
  });
  await until(() => page.evaluate(() => {
    const frame = document.getElementById('pomodoro-break-probe') || document.getElementById('pomodoro-responsive-probe');
    return !frame || Number(frame.contentWindow.getComputedStyle(frame.contentDocument.body).opacity) === 1;
  }), Boolean, 'screenshot frame finished appearing');
  if (page.screenshot) await page.screenshot({ path: file, fullPage: true });
  else await writeFile(file, Buffer.from(await e.driver.takeScreenshot(), 'base64'));
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
    assert.equal(await page.evaluate(() => document.getElementById('pomodoro-stop').hidden), true);
    assert.equal((await command(page, { type: 'stop_pomodoro', id: first.pomodoroSession.id })).code, 'hardcore_active');
    await expireHardcore(page);
    await until(() => state(e), s => s.pomodoroSession === null, 'Hardcore fixed deadline');
    assert.equal((await state(e)).focusSession.focusActive, false);
  }
}, {
  id: '95', title: 'Pomodoro restart restores waiting after an overdue break and Free retains the complete 25/5 preset', persistent: true,
  async run(e) {
    await e.seed({ rules: [rule(201, 'always')] });
    let page = await popup(e);
    await start(page, { auto: true });
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
    await endPomodoro(page);
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
    await endPomodoro(page);
    await until(() => state(e), s => s.pomodoroSession === null, 'Free Stop ends whole cycle');
  }
}];

pomodoroScenarios.push({
  id: '96', title: 'Pomodoro overdue native recovery waits without replay and Free controls retain the standard 25/5 cycle',
  async run(e) {
    await e.seed({ rules: [rule(201, 'always')] });
    let page = await popup(e);
    await start(page, { auto: true });
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
    await endPomodoro(page);
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
    await endPomodoro(page);
    await until(() => state(e), s => s.pomodoroSession === null, 'Free Stop');
  }
});

pomodoroScenarios.push({
  id: '97', title: 'Pomodoro responsive fields, visible primary action and keyboard-safe End confirmation',
  async run(e) {
    await e.seed({ pro: false, rules: [rule(201, 'always')] });
    const page = await popup(e);
    for (const layout of [{ width: 320 }, { width: 360 }, { width: 768 }, { width: 360, zoom: true }, { width: 360, rtl: true }]) {
      await page.evaluate(async layout => {
        document.getElementById('pomodoro-responsive-probe')?.remove();
        const frame = document.createElement('iframe');
        frame.id = 'pomodoro-responsive-probe';
        frame.style.cssText = `display:block; width:${layout.width}px; height:1100px; border:1px solid #aaa; max-width:none;`;
        frame.src = location.href;
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
        document.body.prepend(frame);
        await loaded;
      }, layout);
      await until(() => page.evaluate(() => document.getElementById('pomodoro-responsive-probe').contentDocument.body.classList.contains('ready')), Boolean, 'responsive frame ready');
      const geometry = await page.evaluate(layout => {
        const frame = document.getElementById('pomodoro-responsive-probe');
        const doc = frame.contentDocument;
        if (layout.zoom) doc.documentElement.style.fontSize = '200%';
        if (layout.rtl) {
          doc.documentElement.dir = 'rtl';
          doc.querySelector('label[for="focus-cycle-type"]').textContent = 'نوع جلسة التركيز';
          doc.querySelector('label[for="focus-duration"]').textContent = 'مدة العمل بالدقائق';
        }
        const select = doc.getElementById('focus-cycle-type');
        const duration = doc.querySelector('.duration-control');
        const a = select.getBoundingClientRect(), b = duration.getBoundingClientRect();
        return { gap: b.top - a.bottom, height: a.height, left: a.left, right: a.right, width: doc.documentElement.clientWidth,
          scroll: doc.documentElement.scrollWidth };
      }, layout);
      assert.ok(geometry.gap >= 12, JSON.stringify({ layout, geometry }));
      assert.ok(geometry.height >= 44, JSON.stringify({ layout, geometry }));
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 1, JSON.stringify({ layout, geometry }));
      assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify({ layout, geometry }));
      await capture(e, page, `form-${layout.width}${layout.zoom ? '-200' : layout.rtl ? '-rtl' : ''}`);
    }
    await page.evaluate(() => document.getElementById('pomodoro-responsive-probe').remove());
    await select(page, '#focus-cycle-type', 'pomodoro');
    await click(page, '#start-focus-btn');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'Free work started');
    await finishPhase(page, 'work');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'break', 'Free break');
    const appearance = await page.evaluate(() => {
      const next = document.getElementById('pomodoro-next');
      const css = getComputedStyle(next);
      return { disabled: next.disabled, background: css.backgroundColor, color: css.color,
        expected: getComputedStyle(document.getElementById('start-focus-btn')).backgroundColor, text: next.textContent,
        skip: (globalThis.browser || chrome).i18n.getMessage('pomodoro_skip_break') };
    });
    assert.equal(appearance.disabled, false);
    assert.equal(appearance.background, appearance.expected);
    assert.notEqual(appearance.background, appearance.color);
    const luminance = rgb => {
      const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const lights = [luminance(appearance.background), luminance(appearance.color)].sort((a, b) => b - a);
    assert.ok((lights[0] + 0.05) / (lights[1] + 0.05) >= 4.5, 'active primary button has readable text');
    assert.equal(appearance.text, appearance.skip);
    await capture(e, page, 'free-break-primary');
    for (const layout of [{ width: 320 }, { width: 360, zoom: true }]) {
      await page.evaluate(async layout => {
        const frame = document.createElement('iframe');
        frame.id = 'pomodoro-break-probe';
        frame.style.cssText = `display:block; width:${layout.width}px; height:1100px; max-width:none;`;
        frame.src = location.href;
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
        document.body.prepend(frame); await loaded;
      }, layout);
      await until(() => page.evaluate(() => {
        const doc = document.getElementById('pomodoro-break-probe').contentDocument;
        return doc.body.classList.contains('ready') && !doc.getElementById('pomodoro-panel').hidden;
      }), Boolean, 'mobile break rendered');
      const layoutState = await page.evaluate(layout => {
        const doc = document.getElementById('pomodoro-break-probe').contentDocument;
        if (layout.zoom) doc.documentElement.style.fontSize = '200%';
        const next = doc.getElementById('pomodoro-next'), stop = doc.getElementById('pomodoro-stop');
        const a = next.getBoundingClientRect(), b = stop.getBoundingClientRect();
        return { width: doc.documentElement.clientWidth, scroll: doc.documentElement.scrollWidth,
          stacked: b.top >= a.bottom + 7, enabled: !next.disabled, nextRight: a.right, stopRight: b.right };
      }, layout);
      assert.equal(layoutState.enabled, true);
      assert.equal(layoutState.stacked, true);
      assert.ok(layoutState.scroll <= layoutState.width + 1, JSON.stringify(layoutState));
      assert.ok(Math.max(layoutState.nextRight, layoutState.stopRight) <= layoutState.width + 1);
      await capture(e, page, `break-${layout.width}${layout.zoom ? '-200' : ''}`);
      await page.evaluate(() => document.getElementById('pomodoro-break-probe').remove());
    }
    const before = (await state(e)).pomodoroSession;
    await click(page, '#pomodoro-stop');
    await until(() => page.evaluate(() => document.getElementById('pomodoro-end-dialog').open), Boolean, 'confirmation shown');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pomodoro-end-cancel');
    await press(page, 'Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.value), 'end');
    await press(page, 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pomodoro-end-cancel');
    await press(page, 'Escape');
    await until(() => page.evaluate(() => !document.getElementById('pomodoro-end-dialog').open), Boolean, 'Escape cancels End');
    assert.deepEqual((await state(e)).pomodoroSession, before);
    await endPomodoro(page);
    await until(() => state(e), s => s.pomodoroSession === null, 'confirmed End');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'start-focus-btn');
    assert.equal((await state(e)).statistics.successfulFocusSessions, 1);
    await until(() => page.evaluate(() => !document.getElementById('focus-controls').hasAttribute('aria-busy')), Boolean, 'previous End finished');
    await click(page, '#start-focus-btn');
    const again = await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'another Free work interval');
    await until(() => page.evaluate(() => !document.getElementById('focus-controls').hasAttribute('aria-busy')), Boolean, 'Start finished');
    await click(page, '#stop-focus-btn');
    await until(() => page.evaluate(() => document.getElementById('pomodoro-end-dialog').open), Boolean, 'work Stop also requires confirmation');
    await press(page, 'Escape');
    assert.equal((await state(e)).pomodoroSession.id, again.pomodoroSession.id);
    assert.equal((await state(e)).focusSession.focusActive, true);
    await endPomodoro(page);
    await until(() => state(e), s => s.pomodoroSession === null, 'work End confirmed');
    assert.equal((await state(e)).statistics.successfulFocusSessions, 1);
  }
}, {
  id: '98', title: 'Pomodoro Hardcore locks the whole cycle across a break, popup reopening and explicit early continuation',
  async run(e) {
    const rules = [rule(201, 'always'), rule(202, 'daily_limit')];
    await e.seed({ rules, usage: { '202:general': 60 } });
    let page = await popup(e);
    await select(page, '#focus-cycle-type', 'pomodoro');
    await click(page, '#focus-hardcore-mode');
    assert.deepEqual(await page.evaluate(() => ({
      checked: document.getElementById('pomodoro-autoContinue').checked,
      disabled: document.getElementById('pomodoro-autoContinue').disabled,
      preview: !document.getElementById('pomodoro-preview').hidden && document.getElementById('pomodoro-preview').textContent.includes('Hardcore')
    })), { checked: true, disabled: true, preview: true });
    await fill(page, '#focus-duration', '1');
    await fill(page, '#pomodoro-breakMinutes', '1');
    await fill(page, '#pomodoro-rounds', '2');
    await click(page, '#start-focus-btn');
    const first = await until(() => state(e), s => s.pomodoroSession?.phase === 'work', 'Hardcore work');
    assert.equal(first.pomodoroSession.autoContinue, true);
    const deadline = first.pomodoroSession.hardcoreEndTime;
    await finishPhase(page, 'work');
    const rest = await until(() => state(e), s => s.pomodoroSession?.phase === 'break' && s.statistics?.successfulFocusSessions === 1, 'Hardcore break');
    for (const message of [{ type: 'stop_focus_session' }, { type: 'stop_pomodoro', id: rest.pomodoroSession.id },
      { type: 'start_pomodoro', config: {} }, { type: 'start_focus_session', duration: 25 }, { type: 'logout_pro' }]) {
      assert.equal((await command(page, message)).code, 'hardcore_active');
    }
    const clear = await command(page, { type: 'rules:clear', payload: {} });
    assert.equal(clear.error.code, 'hardcore_active');
    assert.deepEqual((await state(e)).rules, rules);
    assert.equal((await state(e)).dailyRuleUsage.usageSeconds['202:general'], 60);
    await e.assertBlocked('http://pomodoro-201.bd-e2e.test/');
    await e.assertBlocked('http://pomodoro-202.bd-e2e.test/');
    page = await popup(e);
    await until(() => page.evaluate(() => document.getElementById('pomodoro-stop').hidden && !document.getElementById('pomodoro-lock-note').hidden && document.getElementById('rule-editing-controls').disabled), Boolean, 'reopened Hardcore controls stay locked');
    assert.equal((await state(e)).pomodoroSession.hardcoreEndTime, deadline);
    await capture(e, page, 'hardcore-break-locked');
    await click(page, '#pomodoro-next');
    const early = await until(() => state(e), s => s.pomodoroSession?.phase === 'work' && s.pomodoroSession.completedRounds === 1, 'explicit early continuation');
    assert.ok(early.pomodoroSession.hardcoreEndTime < deadline);
    assert.equal(early.pomodoroSession.hardcoreEndTime, early.focusSession.focusEndTime);
    await finishPhase(page, 'work');
    await until(() => state(e), s => s.pomodoroSession === null && s.statistics?.successfulFocusSessions === 2, 'finite Hardcore cycle completed');
  }
}, {
  id: '99', title: 'Pomodoro Hardcore deadline releases overdue recovery without replay or invented statistics',
  async run(e) {
    await e.seed({ rules: [rule(201, 'always')] });
    let page = await popup(e);
    await start(page, { hardcore: true, rounds: 3 });
    await finishPhase(page, 'work');
    await until(() => state(e), s => s.pomodoroSession?.phase === 'break' && s.statistics?.successfulFocusSessions === 1, 'one completed work');
    await page.evaluate(async () => {
      const api = globalThis.browser || chrome;
      const { pomodoroSession } = await api.storage.local.get('pomodoroSession');
      const end = Date.now() + 5000;
      await api.storage.local.set({ pomodoroSession: { ...pomodoroSession, phaseEndTime: Date.now() - 8 * 3600_000, hardcoreEndTime: end } });
      await api.alarms.create('pomodoro_hardcore_end', { when: end });
    });
    const ready = await until(() => state(e), s => s.pomodoroSession?.phase === 'ready', 'overdue recovery waits safely');
    assert.equal((await command(page, { type: 'stop_pomodoro', id: ready.pomodoroSession.id })).code, 'hardcore_active');
    await until(() => state(e), s => s.pomodoroSession === null && !s.focusSession.focusActive, 'native fixed deadline released cycle');
    assert.equal((await state(e)).statistics.successfulFocusSessions, 1);
    page = await popup(e);
    await until(() => page.evaluate(() => !document.getElementById('focus-start-view').hidden && !document.getElementById('rule-editing-controls').disabled), Boolean, 'reopened popup usable after deadline');
    assert.equal((await command(page, { type: 'start_focus_session', duration: 25 })).success, true);
    assert.equal((await command(page, { type: 'stop_focus_session' })).success, true);
  }
}, {
  id: '100', title: 'Pomodoro confirmation closes on automatic continuation and stale End cannot cancel new work',
  async run(e) {
    await e.seed({ rules: [rule(201, 'always')] });
    const page = await popup(e);
    await start(page, { auto: true, rounds: 3 });
    await finishPhase(page, 'work');
    const rest = await until(() => state(e), s => s.pomodoroSession?.phase === 'break', 'automatic break');
    await page.evaluate(() => {
      globalThis.__bdPomodoroFocus = [];
      for (const type of ['focusin', 'focusout']) document.addEventListener(type, event => {
        globalThis.__bdPomodoroFocus.push({ type, id: event.target.id, tag: event.target.tagName, at: Date.now() });
      });
    });
    await click(page, '#pomodoro-stop');
    await until(() => page.evaluate(() => document.getElementById('pomodoro-end-dialog').open), Boolean, 'confirmation open during break');
    await finishPhase(page, 'break');
    const work = await until(() => state(e), s => s.pomodoroSession?.phase === 'work' && s.pomodoroSession.completedRounds === 1, 'work starts while confirmation was open');
    await until(() => page.evaluate(() => !document.getElementById('pomodoro-end-dialog').open), Boolean, 'stale confirmation closed');
    await until(() => page.evaluate(() => ({ events: globalThis.__bdPomodoroFocus, id: document.activeElement.id, tag: document.activeElement.tagName, hidden: document.hidden, focused: document.hasFocus(), dialog: document.getElementById('pomodoro-end-dialog').open, activeViewHidden: document.getElementById('focus-active-view').hidden, stopHidden: document.getElementById('stop-focus-btn').hidden, rects: document.getElementById('stop-focus-btn').getClientRects().length, parentHidden: Boolean(document.getElementById('stop-focus-btn').closest('[hidden],.hidden,[inert]')) })), value => value.id === 'stop-focus-btn', 'focus repaired after automatic confirmation close');
    assert.equal((await command(page, { type: 'stop_pomodoro', id: rest.pomodoroSession.id, phase: 'break', completedRounds: 1 })).code, 'pomodoro_changed');
    assert.deepEqual((await state(e)).focusSession, work.focusSession);
    assert.equal((await command(page, { type: 'stop_focus_session' })).success, true);
  }
});
