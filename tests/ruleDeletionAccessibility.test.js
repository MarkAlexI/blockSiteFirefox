import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

async function fixture(run) {
  const document = new FakeDocument(); document.activeElement = document.body;
  const intervals = new Map(), timeouts = new Map(), notices = []; let next = 0;
  const timers = { setInterval: (fn, delay) => { intervals.set(++next, { fn, delay }); return next; },
    clearInterval: id => intervals.delete(id), setTimeout: (fn, delay) => { timeouts.set(++next, { fn, delay }); return next; },
    clearTimeout: id => timeouts.delete(id) };
  const previous = Object.fromEntries(Object.keys(timers).map(key => [key, globalThis[key]]));
  await withExtensionEnvironment(createExtensionApi(), async () => {
    Object.assign(globalThis, timers);
    const { RulesUI } = await import('../rules/rulesUI.js'); const ui = new RulesUI();
    if (ui.deletion) ui.deletion.notify = value => notices.push(value);
    const container = document.addElement('rules-container');
    const row = (id, list = 'general') => { const node = document.createElement('div'); node.dataset.ruleId = String(id);
      node.dataset.assignmentListId = list; const button = document.createElement('button');
      button.className = 'delete-btn'; button.textContent = 'Delete'; button.type = 'button';
      button.setAttribute('aria-label', `Delete: rule-${id}.test`); node.appendChild(button); container.appendChild(node); return { node, button }; };
    const before = row(1), current = row(2), after = row(3), fallback = document.addElement('add-rule', 'button');
    const options = { container, fallback: () => fallback };
    const tick = () => { for (const timer of [...intervals.values()]) timer.fn(); };
    const expire = () => { for (const [id, timer] of [...timeouts]) { timeouts.delete(id); timer.fn(); } };
    const focus = async target => { target.focus(); await document.dispatch('focusin', { target }); };
    try { await run({ ui, document, container, row, before, current, after, fallback, options, tick, expire, focus, intervals, timeouts, notices }); }
    finally { ui.cleanup(); Object.assign(globalThis, previous); }
  }, { document });
}

test('Strict deletion retains a focusable button, a stable site name, and a quiet timer', () => fixture(({ ui, current, tick, notices }) => {
  current.button.focus(); ui.startDeleteCountdown(current.button, () => {}, null, 2, 5);
  assert.equal(current.button.disabled, false);
  assert.equal(current.button.getAttribute('aria-disabled'), 'true');
  assert.equal(current.button.getAttribute('aria-label'), 'Delete: rule-2.test');
  const timer = current.node.querySelector('[role="timer"]'); assert.ok(timer);
  assert.equal(timer.getAttribute('aria-live'), 'off');
  assert.ok(current.button.getAttribute('aria-describedby'));
  const count = notices.length; tick(); assert.equal(notices.length, count);
  tick(); assert.equal(current.button.getAttribute('aria-disabled'), 'false');
  assert.equal(notices.length, count + 1, 'readiness is announced once');
}));

for (const via of ['Escape', 'button']) test(`Strict deletion cancels through ${via} and requires a new countdown`, () => fixture(async ({ ui, current, tick, document }) => {
  let deleted = 0; current.button.focus();
  const done = ui.startDeleteCountdown(current.button, () => { deleted++; }, null, 2, 5);
  const cancel = current.node.querySelector('.delete-cancel'); assert.ok(cancel);
  if (via === 'Escape') { const event = await current.button.dispatch('keydown', { key: 'Escape' }); assert.equal(event.defaultPrevented, true); }
  else { cancel.focus(); const key = await cancel.dispatch('keydown', { key: 'Enter' });
    assert.equal(Boolean(key.defaultPrevented), false, 'Cancel retains native keyboard activation'); await cancel.dispatch('click'); }
  await done; tick(); assert.equal(deleted, 0);
  assert.equal(current.node.querySelector('.delete-cancel'), null);
  assert.equal(current.button.textContent, 'Delete'); assert.equal(document.activeElement, current.button);
  ui.startDeleteCountdown(current.button, () => { deleted++; }, null, 2, 5);
  assert.equal(current.button.getAttribute('aria-disabled'), 'true'); assert.equal(deleted, 0);
}));

test('A focused confirmation remains available beyond the five-second inactivity timeout', () => fixture(async ({ ui, current, tick, expire }) => {
  let deleted = 0; current.button.focus();
  const done = ui.startDeleteCountdown(current.button, () => { deleted++; }, null, 1, 5);
  tick(); expire(); assert.equal(current.button.classList.contains('delete-ready'), true);
  await current.button.dispatch('click'); await done; assert.equal(deleted, 1);
}));

test('An unattended confirmation expires and never deletes automatically', () => fixture(async ({ ui, current, tick, expire, focus, fallback }) => {
  let deleted = 0; const done = ui.startDeleteCountdown(current.button, () => { deleted++; }, null, 1, 5);
  tick(); await focus(fallback); expire(); await done;
  assert.equal(deleted, 0); assert.equal(current.button.textContent, 'Delete');
  assert.equal(ui.isDeleteConfirmationInProgress(current.button), false);
}));

test('Repeated clicks and held Enter cannot confirm early or duplicate an in-flight deletion', () => fixture(async ({ ui, current, tick }) => {
  let release, deleted = 0; const waiting = new Promise(resolve => { release = resolve; });
  const done = ui.startDeleteCountdown(current.button, async () => { deleted++; await waiting; }, null, 2, 5);
  await current.button.dispatch('click'); tick(); await current.button.dispatch('click'); assert.equal(deleted, 0);
  tick(); const repeat = await current.button.dispatch('keydown', { key: 'Enter', repeat: true });
  assert.equal(repeat.defaultPrevented, true);
  const first = current.button.dispatch('click'); await current.button.dispatch('click');
  assert.equal(deleted, 1); assert.equal(current.button.getAttribute('aria-busy'), 'true');
  release(); await first; await done; assert.equal(current.button.getAttribute('aria-busy'), null);
}));

test('Cancelling one countdown leaves another rule countdown intact', () => fixture(async ({ ui, current, after, tick }) => {
  ui.startDeleteCountdown(current.button, () => {}, null, 2, 5);
  ui.startDeleteCountdown(after.button, () => {}, null, 2, 5);
  ui.clearCountdownTimer(current.button); tick();
  assert.equal(after.button.classList.contains('countdown-active'), true);
  assert.equal(after.button.textContent, 'Delete (1)');
}));

test('Disconnected countdown controls and page cleanup cannot issue a later deletion', () => fixture(async ({ ui, current, tick, intervals, timeouts }) => {
  let deleted = 0; const done = ui.startDeleteCountdown(current.button, () => { deleted++; }, null, 1, 5);
  current.node.remove(); tick(); await done; assert.equal(deleted, 0);
  ui.cleanup(); assert.equal(intervals.size, 0); assert.equal(timeouts.size, 0);
  await current.button.dispatch('click'); assert.equal(deleted, 0);
}));

for (const outcome of ['success', 'error']) test(`Deletion refresh restores the next rule after ${outcome}`, () => fixture(async ({ ui, current, after, options, container, document }) => {
  current.button.focus();
  await ui.handleRuleDeletion(current.button, async () => { current.node.remove(); document.activeElement = document.body;
    ui.restoreDeletionFocus?.(container); if (outcome === 'error') throw new Error('safe fixture failure');
  }, false, null, options).catch(() => {});
  assert.equal(document.activeElement, after.button);
}));

test('Deletion of the last visible rule returns focus to Add', () => fixture(async ({ ui, current, before, after, options, document, container, fallback }) => {
  before.node.remove(); after.node.remove(); current.button.focus();
  await ui.handleRuleDeletion(current.button, async () => { current.node.remove(); document.activeElement = document.body;
    ui.restoreDeletionFocus?.(container); }, false, null, options);
  assert.equal(document.activeElement, fallback);
}));

test('A later focus choice wins even if focus subsequently returns to the document body', () => fixture(async ({ ui, current, options, focus, fallback, document, container }) => {
  current.button.focus();
  await ui.handleRuleDeletion(current.button, async () => { await focus(fallback); current.node.remove();
    document.activeElement = document.body; ui.restoreDeletionFocus?.(container); }, false, null, options);
  assert.equal(document.activeElement, document.body);
}));

test('The previous rule is the fallback when deleting the final row', () => fixture(async ({ ui, current, before, after, options, document, container }) => {
  after.node.remove(); current.button.focus();
  await ui.handleRuleDeletion(current.button, () => { current.node.remove(); document.activeElement = document.body;
    ui.restoreDeletionFocus(container); }, false, null, options);
  assert.equal(document.activeElement, before.button);
}));

for (const barrier of ['hidden', 'dialog']) test(`Deletion does not move focus across a ${barrier} boundary`, () => fixture(async ({ ui, current, options, document, container }) => {
  current.button.focus();
  await ui.handleRuleDeletion(current.button, () => { current.node.remove(); document.activeElement = document.body;
    if (barrier === 'hidden') document.hidden = true;
    else document.addElement('modal', 'dialog').setAttribute('open', '');
    ui.restoreDeletionFocus(container); }, false, null, options);
  assert.equal(document.activeElement, document.body);
}));

test('Ordinary deletion ignores duplicates during failure and allows an explicit retry', () => fixture(async ({ ui, current }) => {
  let release, calls = 0; const pending = new Promise(resolve => { release = resolve; });
  const first = ui.handleRuleDeletion(current.button, async () => { calls++; await pending; throw new Error('fixture'); });
  const rejected = assert.rejects(first, /fixture/);
  await ui.handleRuleDeletion(current.button, () => { calls++; }); assert.equal(calls, 1);
  release(); await rejected;
  assert.equal(current.button.getAttribute('aria-disabled'), null);
  await ui.handleRuleDeletion(current.button, () => { calls++; }); assert.equal(calls, 2);
}));

test('Cancelling deletion removes only its own field description and restores caller attributes', () => fixture(async ({ ui, current }) => {
  current.button.setAttribute('aria-describedby', 'existing-hint'); current.button.setAttribute('aria-busy', 'false');
  const done = ui.startDeleteCountdown(current.button, () => {});
  current.button.setAttribute('aria-describedby', current.button.getAttribute('aria-describedby') + ' later-hint');
  await current.button.dispatch('keydown', { key: 'Escape' }); await done;
  assert.equal(current.button.getAttribute('aria-describedby'), 'existing-hint later-hint');
  assert.equal(current.button.getAttribute('aria-busy'), 'false');
}));

test('A waiting rule refresh restores the same assignment and cancels the retired countdown', () => fixture(async ({ ui, current, options, container, row, document }) => {
  current.button.focus(); const done = ui.handleRuleDeletion(current.button, () => assert.fail('retired confirmation'), true, null, options);
  ui.rememberDeletionFocus(container, options.fallback); current.node.remove(); document.activeElement = document.body;
  row(2, 'other-list'); const replacement = row(2);
  ui.restoreDeletionFocus(container); await done;
  assert.equal(document.activeElement, replacement.button);
  assert.equal(ui.isDeleteConfirmationInProgress(current.button), false);
}));

test('Page cleanup removes focus restoration listeners and cannot start a new UI deletion', () => fixture(async ({ ui, current, options, document }) => {
  let release, calls = 0; const pending = new Promise(resolve => { release = resolve; }); current.button.focus();
  const done = ui.handleRuleDeletion(current.button, async () => { calls++; await pending; }, false, null, options);
  ui.cleanup(); assert.equal((document.listeners.get('focusin') || []).length, 0);
  await ui.handleRuleDeletion(current.button, () => { calls++; }); assert.equal(calls, 1);
  release(); await done;
}));

test('Table confirmation uses a full-width row while keeping the action label stable', () => fixture(async ({ ui, document, tick }) => {
  const body = document.addElement('table-rules', 'tbody'), row = document.createElement('tr'); body.appendChild(row);
  for (let i = 0; i < 5; i++) row.appendChild(document.createElement('td'));
  const actions = row.children[4], button = document.createElement('button'); actions.className = 'actions';
  button.className = 'delete-btn'; button.textContent = 'Delete'; actions.appendChild(button); button.focus();
  const done = ui.startDeleteCountdown(button, () => assert.fail('cancelled table confirmation'), null, 1);
  const panel = body.querySelector('.rule-deletion-row'); assert.ok(panel); assert.equal(panel.children[0].colSpan, 5);
  assert.equal(button.textContent, 'Delete'); assert.equal(panel.querySelector('[role="timer"]').textContent, '1');
  tick(); assert.equal(button.textContent, 'Delete'); assert.equal(button.getAttribute('aria-disabled'), 'false');
  await panel.querySelector('.delete-cancel').dispatch('click'); await done;
  assert.equal(body.children.length, 1);
}));

for (const variant of ['popup', 'options', 'assignment']) test(`${variant} guards the settings wait and a replacement button until mutation completes`, async () => {
  const isPopup = variant === 'popup', method = variant === 'assignment' ? 'handleRuleAssignmentDeletion' : 'handleRuleDeletion';
  const source = readFileSync(new URL(isPopup ? '../popup.js' : '../options/options.js', import.meta.url), 'utf8');
  const start = source.indexOf(`  async ${method}(`), end = source.indexOf('\n  ', start + 4);
  // Find the next class member, not an indented statement in the method body.
  const body = source.slice(start).split(/\n  (?=(?:async )?\w+\()/)[0]; assert.ok(start >= 0 && end > start);
  let readRelease, mutateRelease, reads = 0, mutations = 0;
  const reading = new Promise(resolve => { readRelease = resolve; }), mutating = new Promise(resolve => { mutateRelease = resolve; });
  const SettingsManager = { async getSettings() { reads++; await reading; return { mode: 'normal' }; } };
  const C = new Function('SettingsManager', 't', 'customAlert', 'GENERAL_RULE_LIST_ID', `return class C {${body}}`)(SettingsManager, key => key, () => {}, 'general');
  const c = new C(); Object.assign(c, { isPro: false, isLegacyUser: false,
    rulesUI: { isDeleteConfirmationInProgress: () => false, handleRuleDeletion: async (_button, remove) => remove(), showErrorMessage() {} },
    rulesClient: { async deleteRule() { mutations++; await mutating; return {}; }, async removeAssignment() { mutations++; await mutating; return {}; } },
    refreshProfileView: async () => {}, loadRules: async () => {}, showRulesMutationResult() {}, handleRulesMutationError() {}, logRulesMutationFailure() {}, logger: { error() {}, info() {} } });
  const call = button => isPopup ? c[method](button, 7, 'rule.test', { dataset: { isWhitelist: 'false' } }, 'generation', 'general', 4)
    : variant === 'assignment' ? c[method]({ target: button, currentTarget: button }, 7, 'general', 'generation', 4)
      : c[method]({ target: button, currentTarget: button }, 7, 'generation', 4);
  const first = call({}), second = call({}); assert.equal(reads, 1, 'guard precedes settings read');
  readRelease(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const third = call({}); assert.equal(reads, 1, 'replacement button cannot start another authorization');
  mutateRelease(); await Promise.all([first, second, third]); assert.equal(mutations, 1);
});
