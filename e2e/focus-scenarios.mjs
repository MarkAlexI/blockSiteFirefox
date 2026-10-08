import assert from 'node:assert/strict';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const click = (page, selector) => page.locator ? page.locator(selector).click() : page.clickUnsettled(selector);
const type = (page, text) => page.keyboard ? page.keyboard.type(text) : page.typeActive(text);
const editing = '#rules-container tr:has(.save-btn)';

export const focusScenarios = [{
  id: '27',
  title: 'Options Add preserves native keyboard focus through the former 100ms callback in Basic and Daily Limit rules',
  async run(e) {
    const page = await e.openOptions();
    for (const mode of ['always', 'daily_limit']) {
      const url = `keyboard-${mode}.bd-e2e.test`;
      await page.evaluate(() => {
        document.querySelector('#add-rule').addEventListener('click', () => {
          window.__bdFocusProbe = { addedAt: performance.now() };
        }, { capture: true, once: true });
      });
      await click(page, '#add-rule');
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#rules-container tr:has(.save-btn) td:first-child input')), true,
        'Add must focus URL without fill() or an extra settle');
      await type(page, url);
      const elapsed = await page.evaluate(mode => {
        const row = document.querySelector('#rules-container tr:has(.save-btn)');
        if (mode === 'daily_limit') {
          const select = row.querySelector('.blocking-mode-select');
          select.value = mode; select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const chosen = mode === 'daily_limit' ? row.querySelector('.daily-limit-minutes') : row.querySelector('td:nth-child(2) input');
        chosen.value = ''; chosen.focus();
        window.__bdFocusProbe.chosen = chosen;
        return performance.now() - window.__bdFocusProbe.addedAt;
      }, mode);
      assert.ok(elapsed < 100, `Early field change was ${elapsed}ms after Add; the critical window was not exercised`);
      await type(page, mode === 'daily_limit' ? '23' : 'https://redirect.bd-e2e.test');
      await wait(150); // Observe beyond the old callback; no settle before input.
      assert.equal(await page.evaluate(() => document.activeElement === window.__bdFocusProbe.chosen), true, 'late callbacks must not reclaim URL focus');
      const actual = await page.evaluate(() => {
        const row = document.querySelector('#rules-container tr:has(.save-btn)');
        return { url: row.querySelector('td:first-child input').value, value: window.__bdFocusProbe.chosen.value };
      });
      assert.deepEqual(actual, { url, value: mode === 'daily_limit' ? '23' : 'https://redirect.bd-e2e.test' });
      await click(page, `${editing} .save-btn`);
      const until = Date.now() + 15000; let saved;
      do {
        saved = (await e.state()).rules.find(rule => rule.blockURL === url);
        if (saved) break;
        await wait(100);
      } while (Date.now() < until);
      assert.ok(saved, 'persisted rule must exist');
      const assignment = saved.assignments.find(item => item.listId === 'general');
      assert.ok(assignment, 'persisted General assignment must exist');
      assert.equal(saved.blockURL, url);
      assert.equal(saved.redirectURL, mode === 'always' ? 'https://redirect.bd-e2e.test' : '');
      assert.equal(assignment.blockingMode, mode);
      assert.equal(assignment.dailyLimit?.minutes ?? null, mode === 'daily_limit' ? 23 : null);
      const evidence = { mode, elapsedToChosenFieldMs: elapsed, url: saved.blockURL,
        redirect: saved.redirectURL, assignment };
      if (e.result) (e.result.focusEvidence ||= []).push(evidence);
      if (e.testInfo) await e.testInfo.attach(`keyboard-focus-${mode}`, {
        body: JSON.stringify(evidence, null, 2), contentType: 'application/json'
      });
    }
  }
}];

focusScenarios.push({
  id: '28',
  title: 'Popup reader preserves native draft and focus on an unchanged generation with a real change positive control',
  async run(e) {
    const options = await e.openOptions();
    await options.evaluate(async () => {
      const api = globalThis.browser || chrome;
      await api.storage.local.set({ rulesGeneration: 'focus-probe-initial' });
    });
    const page = await e.openPopup();
    if (page.front) await page.front(); else await page.bringToFront();
    const until = Date.now() + 15000;
    while (!await page.evaluate(() => document.querySelector('#add-rule') && !document.querySelector('#add-rule').disabled)) {
      assert.ok(Date.now() < until, 'Popup reader ready'); await wait(50);
    }
    await click(page, '#add-rule');
    while (!await page.evaluate(() => Boolean(document.activeElement?.closest('#rules-container .rule[data-rule-id="null"]')))) {
      assert.ok(Date.now() < until, 'new Popup input gets focus'); await wait(25);
    }
    await type(page, 'draft-native.bd-e2e.test');
    await page.evaluate(async () => {
      const api = globalThis.browser || chrome;
      window.__bdDraft = document.activeElement;
      window.__bdGenerationEvents = [];
      api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.rulesGeneration) window.__bdGenerationEvents.push(changes.rulesGeneration);
      });
      const current = (await api.storage.local.get('rulesGeneration')).rulesGeneration;
      await api.storage.local.set({ rulesGeneration: current });
    });
    await wait(200);
    assert.deepEqual(await page.evaluate(() => ({ connected: window.__bdDraft.isConnected,
      value: window.__bdDraft.value, focused: document.activeElement === window.__bdDraft })),
      { connected: true, value: 'draft-native.bd-e2e.test', focused: true });
    await options.evaluate(async () => {
      const api = globalThis.browser || chrome;
      await api.storage.local.set({ rulesGeneration: 'focus-probe-changed' });
    });
    const changedUntil = Date.now() + 15000;
    while (await page.evaluate(() => window.__bdDraft.isConnected)) {
      assert.ok(Date.now() < changedUntil, 'a real generation change refreshes readers'); await wait(25);
    }
    const events = await page.evaluate(() => window.__bdGenerationEvents);
    assert.ok(events.some(event => event.newValue === 'focus-probe-changed'), 'positive control storage event received');
    if (e.result) e.result.generationEvents = events;
    if (e.testInfo) await e.testInfo.attach('generation-events', { body: JSON.stringify(events), contentType: 'application/json' });
  }
});
