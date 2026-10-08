import assert from 'node:assert/strict';
import { until, pause, readerView, openToolbarPopup, toolbarCount, installPopupProbe,
  expectedPopupRows, assertRenderTrace } from './popup-probes.mjs';

const click = (page, selector) => page.locator ? page.locator(selector).click() : page.clickUnsettled(selector);
const front = page => page.front ? page.front() : page.bringToFront();
const type = (page, value) => page.keyboard ? page.keyboard.type(value) : page.typeActive(value);
const assignment = (listId, minutes = null) => ({ listId, disabledByUser: false,
  blockingMode: minutes === null ? 'always' : 'daily_limit', schedule: null,
  dailyLimit: minutes === null ? null : { minutes } });
const rule = (id, url, assignments) => ({ id, blockURL: url, redirectURL: '',
  category: 'social', isWhitelist: false, assignments });
const send = (page, type, payload) => page.evaluate(async message => {
  const api = globalThis.browser || chrome;
  return api.runtime.sendMessage(message);
}, { type, payload });

async function evidence(e, label, value) {
  if (e.result) (e.result.popupNativeEvidence ||= {})[label] = value;
  if (e.testInfo) await e.testInfo.attach(label, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}
async function ready(view) {
  await until(() => view.evaluate(v => Boolean(v.document.querySelector('#add-rule') &&
    !v.document.querySelector('#add-rule').disabled)), Boolean, 'Popup Add ready');
}
async function exactRows(view, raw, label) {
  const expected = expectedPopupRows(raw);
  return until(() => view.evaluate(v => [...v.document.querySelectorAll('#rules-container .rule[data-rule-id]')]
    .filter(row => row.dataset.ruleId !== 'null').map(row => {
      const status = row.querySelector('.rule-daily-limit-popup');
      const used = status?.textContent.match(/([\d.]+)\s*\/\s*(\d+)/);
      return { id: Number(row.dataset.ruleId), url: row.querySelector('input')?.value,
        list: row.querySelector('.rule-list-popup')?.textContent || null,
        usage: used ? [Number(used[1]), Number(used[2])] : null,
        exhausted: Boolean(status?.classList.contains('limit-reached')) };
    }).sort((a, b) => a.id - b.id)), value => JSON.stringify(value) === JSON.stringify(expected), label);
}
async function kick(e, label) {
  await e.writeLocal({ rulesGeneration: `popup-native-${label}-${Date.now()}` });
}
async function release(view, kind) { await view.evaluate((v, kind) => v.__bdPopupProbe.release(kind), kind); }
const held = (view, kind) => view.evaluate((v, kind) => v.__bdPopupProbe[`held${kind}`].length, kind);

export const popupNativeScenarios = [{
  id: '29', nativeToolbar: true,
  title: 'genuine toolbar Popup discards pending snapshots and row timers across close, reopen and Options navigation',
  async run(e) {
    await e.seed({ rules: [rule(21, 'toolbar-before.bd-e2e.test', [assignment('general')])] });
    const options = await e.openOptions();
    await e.reconcile(options);
    const lifecycle = [];
    for (const kind of ['Reads', 'Rows']) {
      const popup = await openToolbarPopup(options);
      await ready(popup);
      await exactRows(popup, await e.state(), 'initial genuine toolbar rows');
      await popup.evaluate(installPopupProbe);
      await popup.evaluate((v, kind) => { v.__bdPopupProbe[`hold${kind === 'Reads' ? 'Read' : 'Rows'}`] = true; }, kind);
      await kick(e, `toolbar-held-${kind}`);
      await until(() => held(popup, kind), value => value > 0, `native ${kind} result held before close`);

      let closeInput;
      if (e.dismissToolbarPopup) {
        await e.dismissToolbarPopup(); closeInput = 'Gecko chrome widget: WebDriver Escape';
      } else {
        // Use a real click in the Options tab to lose native panel focus.
        await front(options);
        await options.evaluate(() => {
          const button = document.createElement('button'); button.id = '__bdBlurToolbar';
          button.textContent = 'Focus Options';
          button.onclick = event => { window.__bdToolbarBlurTrusted = event.isTrusted; };
          document.body.prepend(button);
        });
        await click(options, '#__bdBlurToolbar');
        assert.equal(await options.evaluate(() => window.__bdToolbarBlurTrusted), true);
        await options.evaluate(() => document.querySelector('#__bdBlurToolbar').remove());
        closeInput = 'Options tab: native pointer click';
      }
      await until(() => toolbarCount(options), count => count === 0, 'real toolbar document destroyed');
      const domain = `toolbar-after-${kind.toLowerCase()}.bd-e2e.test`;
      await e.importBackup(options, { rules: [rule(99, domain, [assignment('general')])] });
      await until(async () => (await e.state()).rules.map(item => item.blockURL),
        urls => urls.length === 1 && urls[0] === domain, 'Options import committed while toolbar is closed');

      const reopened = await openToolbarPopup(options);
      assert.notEqual(reopened.token, popup.token, 'reopening creates a fresh native document');
      await ready(reopened);
      const current = await e.state();
      const rows = await exactRows(reopened, current, 'only current rows after reopen');
      await reopened.evaluate(v => v.document.querySelector('.rule-toggle-popup').click());
      await until(async () => (await e.state()).rules[0]?.assignments[0]?.disabledByUser,
        value => value === true, 'fresh row action targets the imported rule');
      assert.equal((await e.state()).rules[0].blockURL, domain);
      assert.equal((await e.state()).rules.length, 1, 'retired rows cannot add or resurrect rules');

      // Exercise the production link from the genuine popup, including its
      // native openOptionsPage operation and panel/document teardown.
      await reopened.evaluate(v => v.document.querySelector('#options-link').click());
      await until(() => toolbarCount(options), count => count === 0, 'Popup-to-Options closes genuine toolbar');
      const active = await until(() => options.evaluate(async () =>
        (await (globalThis.browser || chrome).tabs.query({ active: true, currentWindow: true }))[0]?.url),
      url => url?.endsWith('/options/options.html'), 'Popup-to-Options activates Options tab');
      lifecycle.push({ held: kind, beforeDocument: popup.token, afterDocument: reopened.token,
        closeInput, rows, activeOptionsUrl: active });
      await evidence(e, 'toolbar-lifecycle', lifecycle);
    }
  }
}, {
  id: '30', title: 'every Popup render uses one coherent native snapshot through import and assignment/profile moves',
  async run(e) {
    await e.seed({ rules: [rule(21, 'snapshot-before.bd-e2e.test', [assignment('general', 10)]),
      rule(22, 'snapshot-other.bd-e2e.test', [assignment('list-1', 5)])],
    usage: { '21:general': 420, '22:list-1': 120 } });
    const options = await e.openOptions();
    await e.reconcile(options);
    const page = await e.openPopup(); const view = readerView(page);
    await front(page); await ready(view); await exactRows(view, await e.state(), 'reader initial rows');
    await view.evaluate(installPopupProbe);
    await view.evaluate(v => { v.__bdPopupProbe.holdRead = true; });
    await kick(e, 'pre-import');
    await until(() => held(view, 'Reads'), count => count === 1, 'old native snapshot captured');
    const heldGeneration = await view.evaluate(v => v.__bdPopupProbe.reads.find(read => read.gated).raw.rulesGeneration);
    await e.importBackup(options, { rules: [rule(101, 'snapshot-import-a.bd-e2e.test', [assignment('list-1', 29)]),
      rule(102, 'snapshot-import-b.bd-e2e.test', [assignment('list-1', 7)])],
    ruleLists: [{ id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Imported Study', disabledCategories: [] },
      { id: 'list-2', name: 'Imported Work', disabledCategories: [] }], activeRuleListId: 'list-1' });
    const imported = await until(() => e.state(), state => state.rules.length === 2 &&
      state.rules.every(item => item.blockURL.startsWith('snapshot-import-')) && state.activeRuleListId === 'list-1', 'native import committed');
    await exactRows(view, imported, 'import refresh overtakes old snapshot');
    const importTrace = await view.evaluate(v => v.__bdPopupProbe.renders);
    assert.ok(importTrace.length > 0, 'render happened before releasing the old read');
    assert.ok(importTrace.every(event => event.raw.rulesGeneration !== heldGeneration), 'held generation did not render');
    await release(view, 'reads');
    await pause(100);
    await exactRows(view, await e.state(), 'late old storage result cannot replace import');

    const a = imported.rules.find(item => item.blockURL.endsWith('-a.bd-e2e.test'));
    const b = imported.rules.find(item => item.blockURL.endsWith('-b.bd-e2e.test'));
    const date = await page.evaluate(() => {
      const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    await e.writeLocal({ dailyRuleUsage: { version: 2, date,
      usageSeconds: { [`${a.id}:list-1`]: 1386, [`${b.id}:list-1`]: 540 }, lastSample: null } });
    await exactRows(view, await e.state(), 'native nonempty budgets before move');
    await view.evaluate(v => { v.__bdPopupProbe.holdRows = true; });
    await kick(e, 'pre-move');
    await until(() => held(view, 'Rows'), count => count === 2, 'old row timers both delivered by the browser');
    // Future timers run normally; only the already delivered old callbacks wait.
    await view.evaluate(v => { v.__bdPopupProbe.holdRows = false; });
    const before = await e.state();
    const moved = await send(options, 'rules:update', {
      ruleId: a.id, assignmentListId: 'list-1', blockURL: a.blockURL, redirectURL: a.redirectURL,
      assignment: assignment('list-2', 31), expectedGeneration: before.rulesGeneration ?? null,
      expectedRevision: before.ruleRevisions?.[a.id] ?? null, expectedListRevisions: before.ruleListRevisions || {}
    });
    assert.equal(moved.success, true, JSON.stringify(moved));
    const after = await e.state();
    const activated = await send(options, 'rules:activateList', { listId: 'list-2',
      expectedGeneration: after.rulesGeneration ?? null, expectedListRevision: after.ruleListRevisions?.['list-2'] ?? null });
    assert.equal(activated.success, true, JSON.stringify(activated));
    const final = await until(() => e.state(), state => state.activeRuleListId === 'list-2' &&
      state.pendingDailyUsageRemaps?.length === 0 && state.dailyRuleUsage.usageSeconds[`${a.id}:list-2`] === 1386,
    'move journal committed with preserved budget');
    await exactRows(view, final, 'new profile rendered before old row callbacks return');
    await release(view, 'rows');
    await pause(100);
    await exactRows(view, final, 'retired row callbacks cannot insert duplicates or old assignments');
    const trace = await view.evaluate(v => v.__bdPopupProbe.renders);
    await evidence(e, 'all-popup-renders', trace);
    assertRenderTrace(trace);
    assert.ok(trace.every(event => event.raw.rulesGeneration !== heldGeneration), 'obsolete returned snapshot never clears or renders after import');
    assert.ok(new Set(trace.map(event => event.raw.rulesGeneration)).size >= 2, 'distinct stored generations rendered');
    assert.notEqual(final.ruleRevisions[a.id], before.ruleRevisions[a.id], 'move has a new rule revision within the same generation');
    assert.ok(trace.some(event => event.rows.some(row => row.exhausted && row.usage[0] === 7)), 'trace includes a nonempty exhausted budget');
    assert.deepEqual(expectedPopupRows(final), [{ id: a.id, url: a.blockURL, list: 'Imported Work', usage: [23.1, 31], exhausted: false }]);

    // Check the generation/revision captured by the rendered row's closure,
    // as well as its visible fields. Forward the real production intent.
    await front(page);
    await click(page, `.rule[data-rule-id="${a.id}"] .delete-btn`);
    const intent = await until(() => view.evaluate(v => v.__bdPopupProbe.messages.find(message => message.type === 'rules:removeAssignment')),
      Boolean, 'rendered row sent its native mutation');
    assert.deepEqual(intent.payload, { ruleId: a.id, listId: 'list-2',
      expectedGeneration: final.rulesGeneration, expectedRevision: final.ruleRevisions[a.id] });
    await until(() => e.state(), state => state.rules.length === 1 && state.rules[0].id === b.id,
      'row action removes only its current assignment');
    await evidence(e, 'rendered-row-intent', intent);
  }
}, {
  id: '31', title: 'native Popup row timer and animation frame preserve initial, chosen and retired focus across background/foreground',
  async run(e) {
    // A persisted row keeps the production Focus section visible when a
    // refresh retires drafts, so the later native click has a real target.
    await e.seed({ rules: [rule(21, 'focus-existing.bd-e2e.test', [assignment('general')])] });
    const page = await e.openPopup(); const view = readerView(page);
    await front(page); await ready(view); await exactRows(view, await e.state(), 'initial reader');
    await view.evaluate(installPopupProbe);
    await view.evaluate(v => { v.__bdPopupProbe.holdRows = true; });
    await click(page, '#add-rule');
    await until(() => held(view, 'Rows'), count => count === 1, 'native Add row timer held');
    assert.deepEqual(await view.evaluate(v => ({ connected: v.document.querySelectorAll('.rule[data-rule-id="null"]').length,
      requested: v.__bdPopupProbe.tasks.includes('frame-requested') })), { connected: 0, requested: false },
    'no frame is requested before the new input is connected');
    await release(view, 'rows');
    await until(() => view.evaluate(v => Boolean(v.document.activeElement?.matches('.rule[data-rule-id="null"] input:first-child'))),
      Boolean, 'native frame initially focuses the connected URL input');
    await type(page, 'initial-frame.bd-e2e.test');

    await view.evaluate(v => { v.__bdPopupProbe.holdFrames = true; });
    await click(page, '#add-rule');
    await until(() => held(view, 'Frames'), count => count === 1, 'native frame delivered but its focus callback held');
    await view.evaluate(v => {
      const row = v.document.querySelector('.rule[data-rule-id="null"]');
      v.__bdChosen = row.querySelectorAll('input')[1]; v.__bdChosen.id = '__bdChosenRedirect';
    });
    await click(page, '#__bdChosenRedirect');
    await type(page, 'https://chosen-frame.bd-e2e.test');
    await release(view, 'frames');
    assert.deepEqual(await view.evaluate(v => ({ focused: v.document.activeElement === v.__bdChosen, value: v.__bdChosen.value })),
      { focused: true, value: 'https://chosen-frame.bd-e2e.test' }, 'late frame respects a native user field choice');

    await view.evaluate(v => { v.__bdPopupProbe.holdFrames = true; });
    await click(page, '#add-rule');
    await until(() => held(view, 'Frames'), count => count === 1, 'retiring row has a pending native frame');
    await view.evaluate(v => { v.__bdRetired = v.document.querySelector('.rule[data-rule-id="null"] input'); });
    await kick(e, 'retire-frame');
    await until(() => view.evaluate(v => v.__bdRetired.isConnected), connected => connected === false, 'refresh retires the draft input');
    await click(page, '#focus-duration');
    await release(view, 'frames');
    assert.equal(await view.evaluate(v => v.document.activeElement.id), 'focus-duration', 'retired callback cannot reclaim focus');

    // The row is inserted while truly backgrounded. Its browser rAF cannot
    // become an initial focus callback until the reader is foreground again.
    await view.evaluate(v => { v.__bdPopupProbe.holdRows = true; v.__bdPopupProbe.holdFrames = true; });
    await click(page, '#add-rule');
    await until(() => held(view, 'Rows'), count => count === 1, 'background case row timer captured');
    const options = await e.openOptions();
    const hidden = await until(() => view.evaluate(v => ({ visibility: v.document.visibilityState, focused: v.document.hasFocus() })),
      value => value.visibility === 'hidden' && value.focused === false, 'actual background visibility');
    const active = await options.evaluate(async () =>
      (await (globalThis.browser || chrome).tabs.query({ active: true, currentWindow: true }))[0]?.url);
    assert.ok(active.endsWith('/options/options.html'), 'actual active tab is Options');
    await release(view, 'rows');
    await pause(100);
    assert.equal(await held(view, 'Frames'), 0, 'native rAF has not delivered in the hidden document');
    await front(page);
    const visible = await until(() => view.evaluate(v => ({ visibility: v.document.visibilityState, focused: v.document.hasFocus() })),
      value => value.visibility === 'visible' && value.focused === true, 'native reader foreground restored');
    await until(() => held(view, 'Frames'), count => count === 1, 'native frame resumes in foreground');
    await release(view, 'frames');
    await until(() => view.evaluate(v => Boolean(v.document.activeElement?.matches('.rule[data-rule-id="null"] input:first-child'))),
      Boolean, 'background-created row gets its initial focus after foreground');
    const tasks = await view.evaluate(v => v.__bdPopupProbe.tasks);
    assert.ok(tasks.indexOf('row-insert') < tasks.indexOf('frame-requested'), 'insertion precedes the first frame request');
    await evidence(e, 'native-popup-focus', { hidden, visible, activeOptionsUrl: active, tasks });
  }
}];
