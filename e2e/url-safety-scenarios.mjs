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
}, {
  id: '78', title: 'Invalid legacy filters preserve valid native blockers, removals, and daily budgets until repaired',
  async run(e) {
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
    // An empty stored target is rejected before URL parsing. Host wildcards,
    // spaces, and Unicode can serialize differently across browser engines.
    const invalid = { id: 781, blockURL: '', redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [{ ...assignment, blockingMode: 'daily_limit', dailyLimit: { minutes: 1 } }] };
    const old = { id: 782, blockURL: 'removed.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [assignment] };
    await e.seed({ pro: true, rules: [invalid, old], usage: { '781:general': 60 } });
    const page = await e.openOptions();
    const initial = await e.state();
    assert.deepEqual(initial.rules.find(rule => rule.id === invalid.id), invalid, 'the malformed saved row is present');
    assert.equal(initial.dailyRuleUsage.usageSeconds['781:general'], 60, 'its daily budget is exhausted');
    const precondition = await page.evaluate(async input => {
      const api = globalThis.browser || chrome;
      const { createDnrRuleFactory, InvalidDnrUrlFilterError } = await import(api.runtime.getURL('rules/dnrRuleFactory.js'));
      try {
        const rule = createDnrRuleFactory(path => api.runtime.getURL(path))(
          input.id, input.blockURL, input.redirectURL, 'daily_limit'
        );
        return { urlFilter: rule.condition.urlFilter };
      } catch (error) {
        return { invalidFilter: error instanceof InvalidDnrUrlFilterError, errorName: error.name };
      }
    }, invalid);
    assert.deepEqual(precondition, { invalidFilter: true, errorName: 'TypeError' },
      'the production factory in the native browser rejects the fault fixture');
    const mutate = async (type, payload) => {
      const state = await e.state();
      return message(page, { type, payload: { ...payload,
        expectedGeneration: state.rulesGeneration ?? null,
        expectedRevision: state.ruleRevisions?.[payload.ruleId] ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
    };
    const added = await mutate('rules:add', { blockURL: 'partialnext', redirectURL: '', category: 'social', assignment });
    assert.equal(added.success, true);
    assert.equal(added.syncPending, true, 'the invalid saved row remains a reported synchronization failure');
    const partial = await e.state();
    assert.deepEqual(partial.rules.find(rule => rule.id === invalid.id), invalid);
    assert.equal(partial.dailyRuleUsage.usageSeconds['781:general'], 60);
    assert.equal(partial.dnr.some(rule => rule.id === invalid.id), false, 'the invalid saved filter was excluded');
    assert.ok(partial.dnr.some(rule => rule.condition.urlFilter === '||partialnext'));
    assert.ok(partial.dnr.some(rule => rule.id === old.id));
    assert.ok(partial.dnr.every(rule => !rule.condition.urlFilter.startsWith('||*')));
    await e.assertBlocked('http://partialnext.bd-e2e.test/page', 'always');

    const removed = await mutate('rules:delete', { ruleId: old.id });
    assert.equal(removed.success, true);
    assert.equal(removed.syncPending, true);
    const control = await e.newPage('http://removed.bd-e2e.test/page');
    assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    assert.equal((await e.state()).dnr.some(rule => rule.id === old.id), false);

    const repaired = await mutate('rules:update', { ruleId: invalid.id, blockURL: 'repaired.bd-e2e.test',
      redirectURL: '', category: invalid.category, assignment: invalid.assignments[0] });
    assert.equal(repaired.success, true);
    assert.equal(repaired.syncPending, false);
    assert.equal((await e.state()).dailyRuleUsage.usageSeconds['781:general'], 60);
    await e.assertBlocked('http://repaired.bd-e2e.test/page', 'daily_limit');
  }
}, {
  id: '79', title: 'Native DNR and runtime matching retain non-default ports and short URL fragments',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    const portTarget = 'portcase.bd-e2e.test:18080/blocked';
    const defaultTarget = 'defaultpath.bd-e2e.test/blocked';
    const patterns = [portTarget, defaultTarget, 'portpartial'];
    // Prove the fixture transport accepts both ports before installing rules.
    for (const port of [18080, 18081]) {
      const control = await e.newPage(`http://portcase.bd-e2e.test:${port}/open`);
      assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    }
    for (const blockURL of patterns) {
      const state = await e.state();
      const result = await message(page, { type: 'rules:add', payload: {
        blockURL, redirectURL: '', category: 'social',
        assignment: { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        expectedGeneration: state.rulesGeneration ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
      assert.equal(result.success, true);
      assert.equal(result.syncPending, false, 'the native DNR update completed');
    }
    const state = await e.state();
    assert.deepEqual(state.rules.map(rule => rule.blockURL).sort(), [...patterns].sort());
    assert.deepEqual(state.dnr.map(rule => rule.condition.urlFilter).sort(), patterns.map(pattern => `||${pattern}`).sort());

    const cases = [
      { url: 'http://portcase.bd-e2e.test:18080/blocked/one', pattern: portTarget, blocked: true },
      { url: 'http://sub.portcase.bd-e2e.test:18080/blocked/one', pattern: portTarget, blocked: true },
      { url: 'http://portcase.bd-e2e.test:18081/blocked/one', pattern: portTarget, blocked: false },
      { url: 'http://portcase.bd-e2e.test/blocked/one', pattern: portTarget, blocked: false },
      { url: 'http://defaultpath.bd-e2e.test:18080/blocked/one', pattern: defaultTarget, blocked: false },
      { url: 'http://defaultpath.bd-e2e.test/blocked/one', pattern: defaultTarget, blocked: true },
      { url: 'http://m.portpartial.bd-e2e.test:18081/open', pattern: 'portpartial', blocked: true },
      { url: 'http://notportpartial.bd-e2e.test:18081/open', pattern: 'portpartial', blocked: false }
    ];
    const matched = await page.evaluate(async cases => {
      const api = globalThis.browser || chrome;
      const { doesUrlMatchBlockRule } = await import(api.runtime.getURL('rules/urlRuleMatcher.js'));
      return cases.map(input => doesUrlMatchBlockRule(input.url, input.pattern));
    }, cases);
    assert.deepEqual(matched, cases.map(input => input.blocked), 'the runtime matcher observes serialized request ports');
    for (const input of cases) {
      if (input.blocked) {
        await e.assertBlocked(input.url, 'always');
      } else {
        const control = await e.newPage(input.url);
        assert.equal(await control.url(), input.url);
        assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
      }
    }
  }
}];
