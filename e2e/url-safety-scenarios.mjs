import assert from 'node:assert/strict';

async function poll(read, check, label) {
  const deadline = Date.now() + 15_000;
  do {
    const value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(label);
}

const message = (page, input) => page.evaluate(input => {
  if (globalThis.browser) return browser.runtime.sendMessage(input);
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(input, reply => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(reply);
  }));
}, input);

const createTab = (page, url) => page.evaluate(async url => {
  const tab = await (globalThis.browser || chrome).tabs.create({ url, active: false });
  return tab.id;
}, url);
const tabIds = page => page.evaluate(async () =>
  (await (globalThis.browser || chrome).tabs.query({})).map(tab => tab.id));

export const urlSafetyScenarios = [{
  id: '76', title: 'Whitelist Focus closes real web tabs with browser-page names while preserving allowed and internal tabs',
  async run(e) {
    await e.seed({ pro: true, rules: [{
      id: 72, blockURL: 'allowed.bd-e2e.test', redirectURL: '', category: 'whitelist', isWhitelist: true,
      assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }]
    }] });
    const page = await e.openOptions();
    const allowed = await createTab(page, 'http://allowed.bd-e2e.test/');
    const internal = await createTab(page, 'about:blank');
    assert.ok(Number.isInteger(allowed) && Number.isInteger(internal));
    assert.equal((await message(page, {
      type: 'start_focus_session', duration: 5, focusMode: 'whitelist'
    })).success, true);
    try {
      for (const url of [
        'http://unlisted.bd-e2e.test/ordinary',
        'http://unlisted.bd-e2e.test/chrome-extension://open',
        'http://unlisted.bd-e2e.test/moz-extension://open',
        'http://unlisted.bd-e2e.test//newtab/page',
        'http://newtab.bd-e2e.test/'
      ]) {
        const forbidden = await createTab(page, url);
        assert.ok(Number.isInteger(forbidden), 'the native browser created the observed tab');
        await poll(() => tabIds(page), ids => !ids.includes(forbidden), `Whitelist Focus closes ${url}`);
        const retained = await tabIds(page);
        assert.ok(retained.includes(allowed), 'allowed site remains open');
        assert.ok(retained.includes(internal), 'real internal page remains open');
        const focus = (await e.state()).focusSession;
        assert.equal(focus.focusActive, true);
        assert.equal(focus.focusMode, 'whitelist');
      }
    } finally {
      assert.equal((await message(page, { type: 'stop_focus_session' })).success, true);
    }
  }
}, {
  id: '77', title: 'Native DNR distinguishes encoded path separators and retains partial-domain rules',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    for (const blockURL of ['encoded.bd-e2e.test/a%2Fb', 'partial']) {
      const snapshot = await e.state();
      const result = await message(page, { type: 'rules:add', payload: {
        blockURL, redirectURL: '', category: 'social',
        assignment: { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        expectedGeneration: snapshot.rulesGeneration ?? null,
        expectedListRevisions: snapshot.ruleListRevisions || {}
      } });
      assert.equal(result.success, true);
      assert.equal(result.syncPending, false, 'the native DNR update completed');
    }
    const state = await e.state();
    assert.ok(state.dnr.some(rule => rule.condition.urlFilter === '||encoded.bd-e2e.test/a%2Fb'));
    assert.ok(state.dnr.some(rule => rule.condition.urlFilter === '||partial'));
    for (const url of [
      'http://encoded.bd-e2e.test/a/b',
      'http://notpartial.bd-e2e.test/partial'
    ]) {
      const control = await e.newPage(url);
      assert.equal(await control.url(), url, 'a distinct literal path or unrelated hostname is allowed');
      assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    }
    await e.assertBlocked('http://encoded.bd-e2e.test/a%2Fb', 'always');
    await e.assertBlocked('http://partial.bd-e2e.test/page', 'always');
  }
}];
