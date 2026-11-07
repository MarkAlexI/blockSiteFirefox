import assert from 'node:assert/strict';

const root = '[data-focus-schedule]';
const category = '#categories-container .category-card:first-child input';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, check, label, timeout = 15_000) {
  const until = Date.now() + timeout;
  let value;
  while (Date.now() < until) {
    value = await read();
    if (check(value)) return value;
    await pause(200);
  }
  assert.fail(`${label}: timeout; last=${JSON.stringify(value)}`);
}
const equal = (read, expected, label, timeout) => eventually(read, value => {
  try { assert.deepEqual(value, expected); return true; } catch { return false; }
}, label, timeout);
const click = (page, css) => page.locator ? page.locator(css).click() : page.click(css);
const fill = (page, css, value) => page.locator ? page.locator(css).fill(value) : page.fill(css, value);

async function keyboardActivate(page, css) {
  if (page.front) await page.front(); else await page.bringToFront();
  await page.evaluate(css => document.querySelector(css).focus(), css);
  if (page.keyboard) await page.keyboard.press('Enter'); else await page.press('Enter');
}

async function watchScheduleFeedback(page) {
  const mounted = await page.evaluate(() => {
    const panel = document.querySelector('[data-focus-schedule]');
    const region = document.querySelector('[data-focus-announcer]');
    const events = window.__bdScheduleFeedback = { deliveries: [], summaryWrites: 0 };
    if (!region) return null;
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target === region || region.contains(record.target)) {
          if (region.textContent) events.deliveries.push(region.textContent);
        } else events.summaryWrites++;
      }
    });
    const options = { childList: true, characterData: true, subtree: true };
    observer.observe(region, options);
    panel.querySelectorAll('[data-focus-status], [data-focus-skipped], [data-focus-restore]')
      .forEach(node => observer.observe(node, options));
    return { count: document.querySelectorAll('[data-focus-announcer]').length,
      role: region.getAttribute('role'), live: region.getAttribute('aria-live'),
      atomic: region.getAttribute('aria-atomic'), tabindex: region.getAttribute('tabindex'),
      text: region.textContent, outsidePanel: !panel.contains(region),
      exposed: getComputedStyle(region).display !== 'none' && !region.closest('[hidden], dialog, details, fieldset'),
      otherScheduleChannels: panel.querySelectorAll('[aria-live], [role="status"], [role="alert"]').length };
  });
  assert.deepEqual(mounted, { count: 1, role: 'status', live: 'polite', atomic: 'true', tabindex: null,
    text: '', outsidePanel: true, exposed: true, otherScheduleChannels: 0 });
}

async function scheduleAnnouncement(page, key, timestamp, count) {
  await equal(() => page.evaluate(({ key, timestamp, count }) => {
    const time = new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(timestamp));
    const expected = chrome.i18n.getMessage(key, [time]);
    const deliveries = window.__bdScheduleFeedback.deliveries;
    return Boolean(expected && document.querySelector('[data-focus-announcer]').textContent === expected &&
      deliveries.length === count && deliveries.at(-1) === expected);
  }, { key, timestamp, count }), true, `${key}: one native DOM update per accepted action`);
}

// Native message transport, not the RulesClient helper (schedule fields are top-level).
async function message(page, input) {
  return page.evaluate(async input => {
    if (globalThis.browser) return browser.runtime.sendMessage(input);
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(input, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(response);
    }));
  }, input);
}

// Forwarding-only observer: no response substitution, artificial delay or API double.
export async function observe(page) {
  await page.evaluate(() => {
    window.__bdStale = { calls: [], pendingGets: 0 };
    const events = window.__bdStale;
    const api = globalThis.browser || chrome;
    const original = api.runtime.sendMessage.bind(api.runtime);
    api.runtime.sendMessage = function(input, ...args) {
      const tracked = input?.type?.startsWith('focus_schedule_') || input?.type === 'rules:toggleCategory';
      if (!tracked) return original(input, ...args);
      const event = { message: structuredClone(input), response: null, completed: false };
      events.calls.push(event);
      const get = input.type === 'focus_schedule_get';
      if (get) events.pendingGets++;
      const finish = response => {
        if (event.completed) return response;
        event.response = response;
        event.completed = true;
        if (get) events.pendingGets--;
        return response;
      };
      const callback = args.at(-1);
      try {
        // Chrome also exposes browser.*. Select the calling convention by
        // arguments, not namespace; callback calls return no Promise.
        if (typeof callback === 'function') {
          return original(input, ...args.slice(0, -1), response => {
            finish(response);
            callback(response);
          });
        }
        const result = original(input, ...args);
        if (result && typeof result.then === 'function') {
          return result.then(finish, error => { finish(null); throw error; });
        }
        finish(result);
        return result;
      } catch (error) {
        finish(null);
        throw error;
      }
    };
  });
}

async function lastCall(page, type, minimumCount = 1) {
  return eventually(() => page.evaluate(({ type, minimumCount }) => {
    const calls = window.__bdStale.calls.filter(item => item.message.type === type);
    return calls.length >= minimumCount ? calls.at(-1) : null;
  }, { type, minimumCount }),
  item => item?.completed === true, `${type} native reply`);
}
async function checked(page, css, expected) {
  await equal(() => page.evaluate(css => document.querySelector(css)?.checked ?? null, css), expected, `${css} checked`);
}
async function openSchedule(page) {
  await page.evaluate(() => { location.hash = '#focus-schedule'; });
  await equal(() => page.evaluate(() => document.querySelector('[data-focus-schedule]').open), true, 'schedule editor open');
  await equal(() => page.evaluate(() => document.querySelector('[data-focus-schedule] [name="startTime"]').disabled), false, 'schedule editor ready');
}
async function futureConfig(page, minutes = 5, duration = 2) {
  return page.evaluate(({ minutes, duration }) => {
    const current = new Date();
    const margin = minutes === 1 && current.getSeconds() > 45 ? 1 : 0;
    const next = new Date(current.getTime() + (minutes + margin) * 60_000);
    return { enabled: true, days: [0, 1, 2, 3, 4, 5, 6],
      startTime: `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`,
      durationMinutes: duration };
  }, { minutes, duration });
}
async function save(page, config) {
  const current = await message(page, { type: 'focus_schedule_get' });
  const response = await message(page, { type: 'focus_schedule_save', config, revision: current.revision });
  assert.equal(response.success, true, JSON.stringify(response));
  return response;
}
async function scheduleState(page) {
  return page.evaluate(async () => {
    const api = globalThis.browser || chrome;
    const stored = await api.storage.local.get(['focusSchedule', 'focusSession']);
    return { ...stored, alarms: await api.alarms.getAll(), dnr: await api.declarativeNetRequest.getDynamicRules() };
  });
}
async function listCommand(page, type, listId, extra = {}) {
  const snapshot = await page.evaluate(async () => (globalThis.browser || chrome).storage.local.get(
    ['rulesGeneration', 'ruleListRevisions']));
  const reply = await message(page, { type, payload: { ...extra, listId,
    expectedGeneration: snapshot.rulesGeneration ?? null,
    expectedListRevision: snapshot.ruleListRevisions?.[listId] ?? null } });
  assert.equal(reply.success, true, JSON.stringify(reply));
}
async function protectedCategories(e) {
  const assignment = { listId: 'list-1', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
  await e.seed({ active: 'list-1', rules: [{ id: 21, blockURL: 'category.bd-e2e.test', redirectURL: '',
    category: 'social', isWhitelist: false, assignments: [assignment] }] });
  const a = await e.openOptions(); const b = await e.openOptions();
  await listCommand(b, 'rules:activateList', 'list-1');
  await a.evaluate(async () => {
    const { PasswordUtils } = await import('../pro/password.js');
    const api = globalThis.browser || chrome;
    const { settings } = await api.storage.sync.get('settings');
    await api.storage.sync.set({ settings: { ...settings, enablePassword: true,
      passwordHash: await PasswordUtils.hashPassword('BD-smoke-password') } });
  });
  await observe(a);
  const shown = await e.state();
  await checked(a, category, true);
  await click(a, category);
  await equal(() => a.evaluate(() => document.querySelector('#passwordModal').classList.contains('hidden')), false, 'native password modal');
  return { a, b, shown };
}
async function confirm(page) {
  const before = await page.evaluate(() => window.__bdStale.calls.filter(item => item.message.type === 'rules:toggleCategory').length);
  await fill(page, '#passwordInput1', 'BD-smoke-password');
  await click(page, '#confirmPassword');
  return lastCall(page, 'rules:toggleCategory', before + 1);
}
function stable(state) {
  return { rules: state.rules, lists: state.ruleLists, active: state.activeRuleListId,
    generation: state.rulesGeneration, revisions: state.ruleListRevisions,
    usage: state.dailyRuleUsage.usageSeconds, dnr: state.dnr };
}

export const staleScenarios = [
  {
    id: '21', persistent: true,
    title: 'stale smoke: Skip and Undo preserve original session time across views, A-B-A and restart',
    async run(e) {
      // Popup exposes Focus only when there are saved rules. Keep real Basic
      // protection and a spent Daily Limit as preservation controls for Undo.
      await e.seed({ rules: [
        { id: 21, blockURL: 'undo-basic.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
          assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] },
        { id: 22, blockURL: 'undo-daily.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
          assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 10 } }] }
      ], usage: { '22:general': 45 } });
      const a = await e.openOptions(); const b = await e.openOptions();
      const config = await futureConfig(b);
      const shown = await save(b, config);
      assert.ok(shown.next);
      const old = { type: 'focus_schedule_skip', key: shown.next.key,
        revision: shown.revision, startTime: shown.next.startTime };
      await save(b, { ...config, durationMinutes: 3 });
      const before = (await scheduleState(b)).focusSchedule;
      assert.deepEqual(await message(a, old), { success: false, code: 'schedule_changed' });
      assert.deepEqual((await scheduleState(b)).focusSchedule, before);
      await save(b, config);
      await e.restart();
      const reopened = await e.openOptions();
      const restored = (await scheduleState(reopened)).focusSchedule;
      assert.deepEqual(await message(reopened, old), { success: false, code: 'schedule_changed' });
      assert.deepEqual((await scheduleState(reopened)).focusSchedule, restored);
      await openSchedule(reopened);
      await observe(reopened);
      await watchScheduleFeedback(reopened);
      const beforeRead = await message(reopened, { type: 'focus_schedule_get' });
      // A real worker write and storage event refresh the mounted production UI.
      // Saving identical config changes its revision, while all visible text stays equal.
      const fresh = await message(reopened, { type: 'focus_schedule_save', config, revision: beforeRead.revision });
      assert.equal(fresh.success, true);
      assert.deepEqual(fresh.next, beforeRead.next);
      await equal(() => reopened.evaluate(revision => window.__bdStale.calls.some(item =>
        item.message.type === 'focus_schedule_get' && item.completed && item.response?.revision === revision), fresh.revision),
      true, 'unchanged summary refresh observed through native storage event');
      assert.deepEqual(await reopened.evaluate(() => window.__bdScheduleFeedback), { deliveries: [], summaryWrites: 0 });
      await keyboardActivate(reopened, `${root} [data-focus-skip]`);
      const clicked = await lastCall(reopened, 'focus_schedule_skip');
      assert.deepEqual(clicked.message, { type: 'focus_schedule_skip', key: fresh.next.key,
        revision: fresh.revision, startTime: fresh.next.startTime });
      assert.equal(clicked.response.success, true);
      await equal(() => reopened.evaluate(() => {
        const button=document.querySelector('[data-focus-skip]');
        return document.activeElement===button&&!button.disabled&&!button.hasAttribute('aria-disabled');
      }), true, 'Options Skip retains native keyboard focus');
      await scheduleAnnouncement(reopened, 'focus_schedule_skipped', fresh.next.startTime, 1);
      assert.deepEqual((await scheduleState(reopened)).focusSchedule.skippedKeys, [fresh.next.key]);
      const original = fresh.next;
      const oldUndo = { type: 'focus_schedule_restore', key: original.key,
        revision: clicked.response.revision, startTime: original.startTime };
      const unchanged = stable(await e.state());
      await e.restart();
      const options = await e.openOptions();await openSchedule(options);
      const popup = await e.openPopup();await observe(popup);
      await equal(() => popup.evaluate(() => document.querySelector('[data-focus-restore]').hidden), false, 'Popup Undo after restart');
      await watchScheduleFeedback(options);await watchScheduleFeedback(popup);
      await keyboardActivate(popup, '[data-focus-restore]');
      const undo = await lastCall(popup, 'focus_schedule_restore');
      assert.deepEqual(undo.message, oldUndo);
      assert.equal(undo.response.success, true, JSON.stringify(undo.response));
      assert.deepEqual(undo.response.next, original, 'Undo keeps the exact original native occurrence');
      await equal(() => popup.evaluate(() => document.activeElement===document.querySelector('[data-focus-skip]')),
        true, 'disappearing Popup Undo returns native keyboard focus to Skip');
      await equal(() => options.evaluate(() => document.querySelector('[data-focus-restore]').hidden), true, 'Options observes Popup Undo');
      await scheduleAnnouncement(popup, 'focus_schedule_restored', original.startTime, 1);
      assert.deepEqual(await options.evaluate(() => window.__bdScheduleFeedback.deliveries), [], 'passive Options refresh stays quiet');
      await keyboardActivate(popup, '[data-focus-skip]');
      const againCall = await lastCall(popup, 'focus_schedule_skip');
      assert.deepEqual(againCall.message, { type: 'focus_schedule_skip', key: original.key,
        revision: undo.response.revision, startTime: original.startTime });
      const again = againCall.response;
      assert.equal(again.success, true);
      await equal(() => popup.evaluate(() => {
        const button=document.querySelector('[data-focus-skip]');
        return document.activeElement===button&&!button.disabled&&!button.hasAttribute('aria-disabled');
      }), true, 'Popup Skip retains native keyboard focus');
      await scheduleAnnouncement(popup, 'focus_schedule_skipped', original.startTime, 2);
      const beforeOldUndo = (await scheduleState(options)).focusSchedule;
      assert.deepEqual(await message(popup, oldUndo), { success: false, code: 'schedule_changed' });
      assert.deepEqual((await scheduleState(options)).focusSchedule, beforeOldUndo);
      await equal(() => options.evaluate(() => document.querySelector('[data-focus-restore]').hidden), false, 'fresh Options Undo');
      await observe(options);await click(options, '[data-focus-restore]');
      const freshUndo = await lastCall(options, 'focus_schedule_restore');
      assert.equal(freshUndo.response.success, true);
      assert.deepEqual(freshUndo.response.next, original);
      await scheduleAnnouncement(options, 'focus_schedule_restored', original.startTime, 1);
      assert.deepEqual(stable(await e.state()), unchanged, 'Undo preserves rules, budgets and blocking');
      await e.restart();
      const final = await e.openOptions();
      const persisted = await message(final, { type: 'focus_schedule_get' });
      assert.deepEqual(persisted.next, original);
      assert.equal(persisted.restorable, null);
      assert.deepEqual((await scheduleState(final)).focusSchedule.skippedKeys, []);
      assert.ok((await scheduleState(final)).alarms.some(alarm => alarm.name === 'start_scheduled_focus' &&
        alarm.scheduledTime === original.startTime), 'restored original alarm survives restart');
      await save(final, { ...config, enabled: false });
    }
  },
  {
    id: '22',
    title: 'stale smoke: password-delayed category checkbox keeps its original profile after native activation',
    async run(e) {
      const { a, b, shown } = await protectedCategories(e);
      await listCommand(b, 'rules:activateList', 'general');
      const clickResult = await confirm(a);
      assert.equal(clickResult.message.payload.listId, 'list-1');
      assert.equal(clickResult.message.payload.expectedGeneration, shown.rulesGeneration ?? null);
      assert.equal(clickResult.message.payload.expectedListRevision, shown.ruleListRevisions?.['list-1'] ?? null);
      assert.equal(clickResult.response.success, true, JSON.stringify(clickResult));
      await equal(async () => {
        const state = await e.state();
        return { active: state.activeRuleListId, study: state.ruleLists.find(l => l.id === 'list-1').disabledCategories,
          general: state.ruleLists.find(l => l.id === 'general').disabledCategories, dnr: state.dnr.length };
      }, { active: 'general', study: ['social'], general: [], dnr: 0 }, 'captured profile committed');
      await listCommand(b, 'rules:activateList', 'list-1');
      await checked(a, category, false);
      // Muted category allows navigation even with that profile active.
      const browsing = await e.newPage('http://category.bd-e2e.test/unblocked');
      await equal(() => browsing.url(), 'http://category.bd-e2e.test/unblocked', 'muted category navigation');
      await click(a, category);
      await equal(async () => (await e.state()).dnr.map(rule => rule.id), [21], 'fresh category restores DNR');
      await e.assertBlocked('http://category.bd-e2e.test/blocked');
    }
  },
  {
    id: '23',
    title: 'stale smoke: password-delayed category rejects native rename A-B-A with unchanged state and fresh retry',
    async run(e) {
      const { a, b, shown } = await protectedCategories(e);
      await listCommand(b, 'rules:renameList', 'list-1', { name: 'Renamed' });
      await listCommand(b, 'rules:renameList', 'list-1', { name: 'Study' });
      const before = stable(await e.state());
      const clickResult = await confirm(a);
      assert.equal(clickResult.message.payload.expectedGeneration, shown.rulesGeneration ?? null);
      assert.equal(clickResult.message.payload.expectedListRevision, shown.ruleListRevisions?.['list-1'] ?? null);
      assert.equal(clickResult.response.success, false);
      assert.equal(clickResult.response.error.code, 'rules_state_changed');
      assert.deepEqual(stable(await e.state()), before);
      await checked(a, category, true);
      await click(a, category);
      await equal(() => a.evaluate(() => document.querySelector('#passwordModal').classList.contains('hidden')), false, 'fresh password modal');
      const fresh = await confirm(a);
      assert.equal(fresh.response.success, true);
      assert.notEqual(fresh.message.payload.expectedListRevision, clickResult.message.payload.expectedListRevision);
      await equal(async () => (await e.state()).ruleLists.find(l => l.id === 'list-1').disabledCategories,
        ['social'], 'fresh revision category commit');
      await equal(async () => (await e.state()).dnr, [], 'fresh category DNR removed');
    }
  },
  {
    id: '24',
    title: 'stale smoke: Cancel read preserves same-task DOM input and old form revision; native Save rejects conflict',
    async run(e) {
      const a = await e.openOptions(); const b = await e.openOptions();
      const config = await futureConfig(b);
      const initial = await save(b, config);
      await a.goto(await a.url());
      await openSchedule(a);
      await equal(() => a.evaluate(() => document.querySelector('[data-focus-schedule] [name="startTime"]').value),
        config.startTime, 'initial form values');
      await observe(a);
      const draft = config.startTime === '11:15' ? '11:16' : '11:15';
      // Deterministic ordering, not trusted keyboard input: invoke production Cancel
      // then input in one task before a native message callback can complete.
      const pendingAtInput = await a.evaluate(draft => {
        const root = document.querySelector('[data-focus-schedule]');
        root.querySelector('[data-focus-reset]').click();
        const pending = window.__bdStale.pendingGets;
        const field = root.querySelector('[name="startTime"]');
        field.value = draft;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return pending;
      }, draft);
      assert.ok(pendingAtInput > 0, 'input must occur while real Cancel message is pending');
      await lastCall(a, 'focus_schedule_get');
      const changed = await save(b, { ...config, durationMinutes: 3 });
      assert.ok(changed.revision > initial.revision);
      // Observe the actual storage event reaching A, not just an elapsed delay.
      await equal(() => a.evaluate(revision => window.__bdStale.calls.some(item =>
        item.message.type === 'focus_schedule_get' && item.completed && item.response?.revision === revision), changed.revision),
      true, 'other-window revision refresh observed');
      await equal(() => a.evaluate(() => document.querySelector('[data-focus-schedule] [name="startTime"]').value),
        draft, 'draft preserved after reads');
      const before = (await scheduleState(b)).focusSchedule;
      await click(a, `${root} button[type="submit"]`);
      const rejected = await lastCall(a, 'focus_schedule_save');
      assert.equal(rejected.message.revision, initial.revision);
      assert.equal(rejected.response.code, 'schedule_changed');
      assert.deepEqual((await scheduleState(b)).focusSchedule, before);
      await save(b, { ...config, enabled: false });
    }
  },
  {
    id: '25', persistent: true, timeout: 210_000,
    title: 'stale smoke: an undone skip starts once at its original native alarm and completes across restart',
    async run(e) {
      await e.seed({ rules: [{ id: 21, blockURL: 'scheduled.bd-e2e.test', redirectURL: '', category: 'social',
        isWhitelist: false, assignments: [{ listId: 'list-1', disabledByUser: false,
          blockingMode: 'always', schedule: null, dailyLimit: null }] }] });
      const a = await e.openOptions();
      // Next minute gives the actual browser time to persist and arm the schedule.
      const config = await futureConfig(a, 1, 1);
      const saved = await save(a, config);
      const occurrence = saved.next;
      assert.ok(occurrence && occurrence.startTime > Date.now());
      const skipped = await message(a, { type: 'focus_schedule_skip', key: occurrence.key,
        revision: saved.revision, startTime: occurrence.startTime });
      assert.equal(skipped.success, true);
      const undone = await message(a, { type: 'focus_schedule_restore', key: occurrence.key,
        revision: skipped.revision, startTime: occurrence.startTime });
      assert.equal(undone.success, true, JSON.stringify(undone));
      assert.deepEqual(undone.next, occurrence);
      const initial = await scheduleState(a);
      assert.ok(initial.alarms.some(alarm => alarm.name === 'start_scheduled_focus' && alarm.scheduledTime === occurrence.startTime));
      assert.equal(initial.dnr.some(rule => rule.id === 21), false, 'inactive profile must not block before Focus');
      await eventually(() => scheduleState(a), state => state.focusSession.focusActive && state.dnr.some(rule => rule.id === 21),
        'real alarm activation and DNR', 100_000);
      const active = await scheduleState(a);
      assert.equal(active.focusSession.focusEndTime, occurrence.endTime);
      assert.deepEqual(active.focusSchedule.handledKeys, [occurrence.key]);
      assert.ok(active.alarms.some(alarm => alarm.name === 'end_focus_session' && alarm.scheduledTime === occurrence.endTime));
      await e.assertBlocked('http://scheduled.bd-e2e.test/active', 'focus');
      await e.restart();
      const b = await e.openOptions();
      const restored = await scheduleState(b);
      assert.deepEqual(restored.focusSchedule.handledKeys, [occurrence.key]);
      if (Date.now() < occurrence.endTime) {
        assert.equal(restored.focusSession.focusActive, true);
        assert.equal(restored.focusSession.focusEndTime, occurrence.endTime);
      }
      await eventually(() => scheduleState(b), state => !state.focusSession.focusActive && !state.dnr.some(rule => rule.id === 21),
        'real alarm completion and DNR cleanup', 100_000);
      const completed = await scheduleState(b);
      assert.deepEqual(completed.focusSchedule.handledKeys, [occurrence.key]);
      assert.equal(completed.alarms.some(alarm => alarm.name === 'end_focus_session'), false);
      const browsing = await e.newPage('http://scheduled.bd-e2e.test/finished');
      await equal(() => browsing.url(), 'http://scheduled.bd-e2e.test/finished', 'Focus completed navigation');
      await save(b, { ...config, enabled: false });
    }
  }
];
