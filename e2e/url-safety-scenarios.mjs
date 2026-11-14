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
}, {
  id: '80', title: 'Native wildcard filters agree with runtime matching while internal pages remain excluded',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    const pathPattern = 'wild.bd-e2e.test/feed*/watch';
    const portPattern = 'portwild.bd-e2e.test:18080/a*b';
    for (const url of ['http://wild.bd-e2e.test/open', 'http://portwild.bd-e2e.test:18080/open']) {
      const control = await e.newPage(url);
      assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    }
    for (const blockURL of [pathPattern, portPattern]) {
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
    assert.deepEqual((await e.state()).dnr.map(rule => rule.condition.urlFilter).sort(),
      [`||${pathPattern}`, `||${portPattern}`].sort(), 'the production factory retained native wildcard tokens');
    const cases = [
      { url: 'http://wild.bd-e2e.test/feed/watch', pattern: pathPattern, blocked: true },
      { url: 'http://m.wild.bd-e2e.test/feeds/one/two/watch-more', pattern: pathPattern, blocked: true },
      { url: 'http://wild.bd-e2e.test/feed?next=/watch', pattern: pathPattern, blocked: true },
      { url: 'http://wild.bd-e2e.test/feeds/one/read', pattern: pathPattern, blocked: false },
      { url: 'http://notwild.bd-e2e.test/feeds/one/watch', pattern: pathPattern, blocked: false },
      { url: 'http://portwild.bd-e2e.test:18080/ab', pattern: portPattern, blocked: true },
      { url: 'http://portwild.bd-e2e.test:18080/a/one/b/more', pattern: portPattern, blocked: true },
      { url: 'http://portwild.bd-e2e.test:18081/ab', pattern: portPattern, blocked: false },
      { url: 'http://portwild.bd-e2e.test/ab', pattern: portPattern, blocked: false }
    ];
    const observed = await page.evaluate(async cases => {
      const api = globalThis.browser || chrome;
      const { doesUrlMatchBlockRule } = await import(api.runtime.getURL('rules/urlRuleMatcher.js'));
      return {
        matched: cases.map(input => doesUrlMatchBlockRule(input.url, input.pattern)),
        internal: doesUrlMatchBlockRule('chrome://components/', 'com'),
        invalid: doesUrlMatchBlockRule('http://wild.bd-e2e.test/open', '*'),
        protected: doesUrlMatchBlockRule('https://accounts.google.com/one/watch', 'accounts.google.com/*/watch')
      };
    }, cases);
    assert.deepEqual(observed, { matched: cases.map(input => input.blocked), internal: false, invalid: false, protected: false });
    for (const input of cases) {
      if (input.blocked) await e.assertBlocked(input.url, 'always');
      else {
        const control = await e.newPage(input.url);
        assert.equal(await control.url(), input.url);
        assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
      }
    }
  }
}, {
  id: '81', title: 'Native separator and end anchors agree with runtime decisions and keep escaped operators literal',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    // These supported partial patterns keep the DNR operators after URL
    // normalization. A literal '^' in an ordinary path can become %5E.
    const separator = 'sep-anchor.bd-e2e.test^s:item^';
    const end = 'end-anchor.bd-e2e.test^e:item|';
    const mixed = 'mix-anchor.bd-e2e.test^p:*:end^|';
    const patterns = [separator, end, mixed];
    const compiled = await page.evaluate(async patterns => {
      const api = globalThis.browser || chrome;
      const { createDnrRuleFactory } = await import(api.runtime.getURL('rules/dnrRuleFactory.js'));
      const factory = createDnrRuleFactory(path => api.runtime.getURL(path));
      return patterns.map((pattern, index) => factory(index + 1, pattern, '').condition.urlFilter);
    }, patterns);
    assert.deepEqual(compiled, patterns.map(pattern => `||${pattern}`), 'native fixtures contain the intended operators');
    const reachable = await e.newPage('http://sep-anchor.bd-e2e.test/open');
    assert.equal(await reachable.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    for (const blockURL of patterns) {
      const state = await e.state();
      const result = await message(page, { type: 'rules:add', payload: {
        blockURL, redirectURL: '', category: 'social',
        assignment: { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        expectedGeneration: state.rulesGeneration ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
      assert.equal(result.success, true);
      assert.equal(result.syncPending, false, 'native DNR accepted the generated rules');
    }
    assert.deepEqual((await e.state()).dnr.map(rule => rule.condition.urlFilter).sort(), [...compiled].sort());
    const cases = [
      { url: 'http://sep-anchor.bd-e2e.test/s:item', pattern: separator, blocked: true },
      { url: 'http://sep-anchor.bd-e2e.test/s:item/next', pattern: separator, blocked: true },
      { url: 'http://sep-anchor.bd-e2e.test/s:item?q=1', pattern: separator, blocked: true },
      { url: 'http://sep-anchor.bd-e2e.test/s:items', pattern: separator, blocked: false },
      { url: 'http://sep-anchor.bd-e2e.test/s:item-extra', pattern: separator, blocked: false },
      { url: 'http://end-anchor.bd-e2e.test/e:item', pattern: end, blocked: true },
      { url: 'http://end-anchor.bd-e2e.test/e:item/next', pattern: end, blocked: false },
      { url: 'http://end-anchor.bd-e2e.test/e:item?q=1', pattern: end, blocked: false },
      { url: 'http://mix-anchor.bd-e2e.test/p:one/two:end', pattern: mixed, blocked: true },
      { url: 'http://mix-anchor.bd-e2e.test/p::end/', pattern: mixed, blocked: true },
      { url: 'http://mix-anchor.bd-e2e.test/p:one:end/more', pattern: mixed, blocked: false },
      { url: 'http://mix-anchor.bd-e2e.test/p:one:ended', pattern: mixed, blocked: false }
    ];
    const observed = await page.evaluate(async cases => {
      const api = globalThis.browser || chrome;
      const { doesUrlMatchBlockRule } = await import(api.runtime.getURL('rules/urlRuleMatcher.js'));
      return {
        matched: cases.map(input => doesUrlMatchBlockRule(input.url, input.pattern)),
        escaped: doesUrlMatchBlockRule('http://literal.bd-e2e.test/a%5Eb', 'literal.bd-e2e.test/a%5Eb'),
        separator: doesUrlMatchBlockRule('http://literal.bd-e2e.test/a/b', 'literal.bd-e2e.test/a%5Eb')
      };
    }, cases);
    assert.deepEqual(observed, { matched: cases.map(input => input.blocked), escaped: true, separator: false });
    for (const input of cases) {
      if (input.blocked) await e.assertBlocked(input.url, 'always');
      else {
        const control = await e.newPage(input.url);
        assert.equal(await control.url(), input.url);
        assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
      }
    }
  }
}, {
  id: '82', title: 'Targets normalized to empty never become native match-all blockers and remain repairable',
  async run(e) {
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
    const invalid = { id: 821, blockURL: 'www.', redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [{ ...assignment, blockingMode: 'daily_limit', dailyLimit: { minutes: 1 } }] };
    const valid = { id: 822, blockURL: 'empty-valid.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [assignment] };
    await e.seed({ pro: true, rules: [invalid, valid], usage: { '821:general': 60 } });
    const page = await e.openOptions();
    const classification = await page.evaluate(async targets => {
      const api = globalThis.browser || chrome;
      const { createDnrUrlFilter, InvalidDnrUrlFilterError } = await import(api.runtime.getURL('rules/dnrRuleFactory.js'));
      const { normalizePathRule } = await import(api.runtime.getURL('rules/normalizePathRule.js'));
      return targets.map(target => {
        const normalized = normalizePathRule(target);
        try { return { normalized, urlFilter: createDnrUrlFilter(target) }; }
        catch (error) { return { normalized, invalid: error instanceof InvalidDnrUrlFilterError }; }
      });
    }, ['www.', 'https://www./']);
    assert.deepEqual(classification, [{ normalized: '', invalid: true }, { normalized: '', invalid: true }],
      'the actual browser serializer and production factory classify the fault fixtures');
    const mutate = async (type, payload) => {
      const state = await e.state();
      return message(page, { type, payload: { ...payload,
        expectedGeneration: state.rulesGeneration ?? null,
        expectedRevision: state.ruleRevisions?.[payload.ruleId] ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
    };
    const before = await e.state();
    const rejected = await mutate('rules:add', { blockURL: 'https://www./', redirectURL: '', category: 'social', assignment });
    assert.equal(rejected.success, false);
    assert.deepEqual(rejected.error.validationErrors, ['blockurl_invalid']);
    assert.deepEqual((await e.state()).rules, before.rules, 'invalid additions do not modify saved rows');
    const added = await mutate('rules:add', { blockURL: 'z', redirectURL: '', category: 'social', assignment });
    assert.equal(added.success, true);
    assert.equal(added.syncPending, true, 'the legacy row is still reported for repair');
    const state = await e.state();
    assert.deepEqual(state.rules.find(rule => rule.id === invalid.id), invalid);
    assert.equal(state.dailyRuleUsage.usageSeconds['821:general'], 60);
    assert.equal(state.dnr.some(rule => rule.id === invalid.id || rule.condition.urlFilter === '||'), false);
    assert.ok(state.dnr.some(rule => rule.condition.urlFilter === '||z'), 'one-character fragments remain supported');
    const control = await e.newPage('http://empty-control.bd-e2e.test/page');
    assert.equal(await control.url(), 'http://empty-control.bd-e2e.test/page');
    assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    await e.assertBlocked('http://empty-valid.bd-e2e.test/page', 'always');
    await e.assertBlocked('http://z.bd-e2e.test/page', 'always');
    const repaired = await mutate('rules:update', { ruleId: invalid.id, blockURL: 'empty-repaired.bd-e2e.test',
      redirectURL: '', category: invalid.category, assignment: invalid.assignments[0] });
    assert.equal(repaired.success, true);
    assert.equal(repaired.syncPending, false);
    assert.equal((await e.state()).dailyRuleUsage.usageSeconds['821:general'], 60);
    await e.assertBlocked('http://empty-repaired.bd-e2e.test/page', 'daily_limit');
  }
}, {
  id: '83', title: 'Non-string saved targets preserve valid native blockers and their spent budget through repair',
  async run(e) {
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
    const invalid = { id: 831, blockURL: ['broken'], redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [{ ...assignment, blockingMode: 'daily_limit', dailyLimit: { minutes: 1 } }] };
    const valid = { id: 832, blockURL: 'valid-type.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [assignment] };
    await e.seed({ pro: true, rules: [invalid, valid], usage: { '831:general': 60 } });
    const page = await e.openOptions();
    const classification = await page.evaluate(async () => {
      const api = globalThis.browser || chrome;
      const { createDnrRuleFactory, InvalidDnrUrlFilterError } = await import(api.runtime.getURL('rules/dnrRuleFactory.js'));
      const { doesUrlMatchBlockRule } = await import(api.runtime.getURL('rules/urlRuleMatcher.js'));
      const factory = createDnrRuleFactory(path => api.runtime.getURL(path));
      return {
        invalid: [null, 42, ['broken'], { toString: null }].map(value => {
          try { factory(1, value, ''); return false; }
          catch (error) { return error instanceof InvalidDnrUrlFilterError; }
        }),
        array: doesUrlMatchBlockRule('http://broken.bd-e2e.test/page', ['broken']),
        object: doesUrlMatchBlockRule('http://broken.bd-e2e.test/page', { toString: null }),
        fragment: doesUrlMatchBlockRule('http://broken.bd-e2e.test/page', 'broken')
      };
    });
    assert.deepEqual(classification, { invalid: [true, true, true, true], array: false, object: false, fragment: true });
    const mutate = async (type, payload) => {
      const state = await e.state();
      return message(page, { type, payload: { ...payload,
        expectedGeneration: state.rulesGeneration ?? null,
        expectedRevision: state.ruleRevisions?.[payload.ruleId] ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
    };
    const added = await mutate('rules:add', { blockURL: 'type-safe', redirectURL: '', category: 'social', assignment });
    assert.equal(added.success, true);
    assert.equal(added.syncPending, true, 'the corrupt stored row remains reported for repair');
    const state = await e.state();
    assert.deepEqual(state.rules.find(rule => rule.id === invalid.id), invalid);
    assert.equal(state.dailyRuleUsage.usageSeconds['831:general'], 60);
    assert.equal(state.dnr.some(rule => rule.id === invalid.id), false);
    const control = await e.newPage('http://broken.bd-e2e.test/page');
    assert.equal(await control.url(), 'http://broken.bd-e2e.test/page');
    assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    await e.assertBlocked('http://valid-type.bd-e2e.test/page', 'always');
    await e.assertBlocked('http://type-safe.bd-e2e.test/page', 'always');
    const repaired = await mutate('rules:update', { ruleId: invalid.id, blockURL: 'broken',
      redirectURL: '', category: invalid.category, assignment: invalid.assignments[0] });
    assert.equal(repaired.success, true);
    assert.equal(repaired.syncPending, false);
    assert.equal((await e.state()).dailyRuleUsage.usageSeconds['831:general'], 60);
    await e.assertBlocked('http://broken.bd-e2e.test/page', 'daily_limit');
  }
}, {
  id: '84', title: 'Malformed saved redirects retain native blocking and spent budgets until a valid destination is saved',
  async run(e) {
    const destination = 'http://redirect-target.bd-e2e.test/repaired';
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
    const malformed = { id: 841, blockURL: 'legacy-redirect.bd-e2e.test', redirectURL: [destination],
      category: 'social', isWhitelist: false,
      assignments: [{ ...assignment, blockingMode: 'daily_limit', dailyLimit: { minutes: 1 } }] };
    const valid = { id: 842, blockURL: 'valid-redirect.bd-e2e.test', redirectURL: '',
      category: 'social', isWhitelist: false, assignments: [assignment] };
    await e.seed({ pro: true, rules: [malformed, valid], usage: { '841:general': 60 } });
    const page = await e.openOptions();
    const classification = await page.evaluate(async destination => {
      const api = globalThis.browser || chrome;
      const { createDnrRuleFactory } = await import(api.runtime.getURL('rules/dnrRuleFactory.js'));
      const factory = createDnrRuleFactory(path => api.runtime.getURL(path));
      return [true, 42, [destination], { toString: null }].map(redirectURL => {
        const target = new URL(factory(1, 'yout', redirectURL, 'always').action.redirect.url);
        return { path: target.pathname, reason: target.searchParams.get('reason'), external: target.searchParams.has('to') };
      });
    }, destination);
    assert.deepEqual(classification, Array.from({ length: 4 }, () => ({ path: '/blocked.html', reason: 'always', external: false })));
    const reachable = await e.newPage(destination);
    assert.equal(await reachable.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    const mutate = async (type, payload) => {
      const state = await e.state();
      return message(page, { type, payload: { ...payload,
        expectedGeneration: state.rulesGeneration ?? null,
        expectedRevision: state.ruleRevisions?.[payload.ruleId] ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
    };
    const added = await mutate('rules:add', { blockURL: 'redirect-safe', redirectURL: '', category: 'social', assignment });
    assert.equal(added.success, true);
    assert.equal(added.syncPending, false, 'the malformed destination does not interrupt valid native synchronization');
    const state = await e.state();
    assert.deepEqual(state.rules.find(rule => rule.id === malformed.id), malformed, 'the saved value remains available for repair');
    assert.equal(state.dailyRuleUsage.usageSeconds['841:general'], 60);
    assert.equal(new URL(state.dnr.find(rule => rule.id === malformed.id).action.redirect.url).pathname, '/blocked.html');
    await e.assertBlocked('http://legacy-redirect.bd-e2e.test/page', 'daily_limit');
    await e.assertBlocked('http://valid-redirect.bd-e2e.test/page', 'always');
    await e.assertBlocked('http://redirect-safe.bd-e2e.test/page', 'always');
    const repaired = await mutate('rules:update', { ruleId: malformed.id, blockURL: malformed.blockURL,
      redirectURL: destination, category: malformed.category, assignment: malformed.assignments[0] });
    assert.equal(repaired.success, true);
    assert.equal(repaired.syncPending, false);
    assert.equal((await e.state()).dailyRuleUsage.usageSeconds['841:general'], 60);
    const redirected = await e.newPage('http://legacy-redirect.bd-e2e.test/after-repair');
    await poll(() => redirected.url(), url => url === destination, 'the repaired destination receives a real native redirect');
    assert.equal(await (redirected.locator ? redirected.locator('h1').textContent() : redirected.text('h1')), 'BD E2E fixture');
  }
}];

urlSafetyScenarios.push({
  id: '85', title: 'Native right anchors distinguish an explicit empty query from an absent query',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    // Preserve both patterns as filter syntax: Chromium may serialize a path
    // pipe as %7C before the native DNR compiler can interpret the anchor.
    const exact = 'empty-query-exact.bd-e2e.test^p:item|';
    const query = 'empty-query-only.bd-e2e.test^p:item?|';
    const patterns = [exact, query];
    const compiled = await page.evaluate(async patterns => {
      const api = globalThis.browser || chrome;
      const { createDnrUrlFilter } = await import(api.runtime.getURL('rules/dnrRuleFactory.js'));
      return patterns.map(createDnrUrlFilter);
    }, patterns);
    assert.deepEqual(compiled, patterns.map(pattern => `||${pattern}`), 'the native filters retain the literal query marker and anchors');
    const reachable = await e.newPage('http://empty-query-exact.bd-e2e.test/open?');
    assert.equal(await reachable.url(), 'http://empty-query-exact.bd-e2e.test/open?');
    assert.equal(await reachable.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
    for (const blockURL of patterns) {
      const snapshot = await e.state();
      const response = await message(page, { type: 'rules:add', payload: {
        blockURL, redirectURL: '', category: 'social',
        assignment: { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null },
        expectedGeneration: snapshot.rulesGeneration ?? null,
        expectedListRevisions: snapshot.ruleListRevisions || {}
      } });
      assert.equal(response.success, true);
      assert.equal(response.syncPending, false, 'the browser accepts both production filters');
    }
    assert.deepEqual((await e.state()).dnr.map(rule => rule.condition.urlFilter).sort(), [...compiled].sort());
    const cases = [
      { url: 'http://empty-query-exact.bd-e2e.test/p:item', pattern: exact, blocked: true },
      { url: 'http://empty-query-exact.bd-e2e.test/p:item?', pattern: exact, blocked: false },
      { url: 'http://empty-query-exact.bd-e2e.test/p:item?q=1', pattern: exact, blocked: false },
      { url: 'http://empty-query-exact.bd-e2e.test/p:item%3F', pattern: exact, blocked: false },
      { url: 'http://empty-query-only.bd-e2e.test/p:item?', pattern: query, blocked: true },
      { url: 'http://empty-query-only.bd-e2e.test/p:item', pattern: query, blocked: false },
      { url: 'http://empty-query-only.bd-e2e.test/p:item?q=1', pattern: query, blocked: false },
      { url: 'http://empty-query-only.bd-e2e.test/p:item%3F', pattern: query, blocked: false }
    ];
    const observed = await page.evaluate(async cases => {
      const api = globalThis.browser || chrome;
      const { doesUrlMatchBlockRule } = await import(api.runtime.getURL('rules/urlRuleMatcher.js'));
      return cases.map(input => doesUrlMatchBlockRule(input.url, input.pattern));
    }, cases);
    assert.deepEqual(observed, cases.map(input => input.blocked));
    for (const input of cases) {
      if (input.blocked) await e.assertBlocked(input.url, 'always');
      else {
        const control = await e.newPage(input.url);
        assert.equal(await control.url(), input.url);
        assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
      }
    }
  }
});


urlSafetyScenarios.push({
  id: '86', title: 'Whitelist Focus ignores non-string saved targets while retaining valid fragments and enforcing real tabs',
  async run(e) {
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
    const rule = (id, blockURL) => ({ id, blockURL, redirectURL: '', category: 'whitelist',
      isWhitelist: true, assignments: [{ ...assignment }] });
    const rules = [rule(861, ['coerced-whitelist.bd-e2e.test']), rule(862, true), rule(863, 'permitted')];
    await e.seed({ pro: true, rules });
    const page = await e.openOptions();
    const classification = await page.evaluate(async () => {
      const api = globalThis.browser || chrome;
      const { isUrlInWhitelist } = await import(api.runtime.getURL('pro/isUrlInWhitelist.js'));
      const entry = blockURL => ({ blockURL, isWhitelist: true,
        assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always' }] });
      return {
        array: isUrlInWhitelist('http://coerced-whitelist.bd-e2e.test/page', [entry(['coerced-whitelist.bd-e2e.test'])]),
        boolean: isUrlInWhitelist('http://true.bd-e2e.test/page', [entry(true)]),
        object: isUrlInWhitelist('http://unlisted.bd-e2e.test/page', [entry({ toString: null })]),
        fragment: isUrlInWhitelist('http://m.youtube.com/watch', [entry('tube')])
      };
    });
    assert.deepEqual(classification, { array: false, boolean: false, object: false, fragment: true });
    const inputs = [
      ['coerced', 'http://coerced-whitelist.bd-e2e.test/page'],
      ['boolean', 'http://true.bd-e2e.test/page'],
      ['unlisted', 'http://unlisted-whitelist.bd-e2e.test/page'],
      ['allowed', 'http://permitted.bd-e2e.test/page'],
      ['internal', 'about:blank']
    ];
    const ids = {};
    for (const [name, url] of inputs) ids[name] = await createTab(page, url);
    assert.ok(Object.values(ids).every(Number.isInteger));
    await poll(() => page.evaluate(async ids => {
      const api = globalThis.browser || chrome;
      return Promise.all(Object.values(ids).map(id => api.tabs.get(id)));
    }, ids), tabs => tabs.every(tab => tab.status === 'complete' && !tab.pendingUrl),
    'all observed tabs finish their native navigation before Focus starts');
    assert.equal((await message(page, { type: 'start_focus_session', duration: 5, focusMode: 'whitelist' })).success, true);
    try {
      await poll(() => tabIds(page), tabs => ['coerced', 'boolean', 'unlisted'].every(name => !tabs.includes(ids[name])),
        'only valid string targets can retain real web tabs');
      let retained = await tabIds(page);
      assert.ok(retained.includes(ids.allowed), 'the valid short whitelist fragment remains effective');
      assert.ok(retained.includes(ids.internal), 'the internal tab remains open');
      const next = await createTab(page, 'http://coerced-whitelist.bd-e2e.test/next');
      await poll(() => tabIds(page), tabs => !tabs.includes(next), 'later navigation cannot use a malformed whitelist target');
      retained = await tabIds(page);
      assert.ok(retained.includes(ids.allowed));
      assert.ok(retained.includes(ids.internal));
      const state = await e.state();
      assert.deepEqual(state.rules, rules, 'saved malformed targets remain available for explicit repair');
      assert.equal(state.focusSession.focusActive, true);
      assert.equal(state.focusSession.focusMode, 'whitelist');
    } finally {
      assert.equal((await message(page, { type: 'stop_focus_session' })).success, true);
    }
  }
});


urlSafetyScenarios.push({
  id: '87', title: 'Blank saved targets cannot prevent valid native rule changes or repair of an exhausted budget',
  async run(e) {
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
    const row = (id, blockURL, isWhitelist = false) => ({ id, blockURL, redirectURL: '',
      category: isWhitelist ? 'whitelist' : 'social', isWhitelist, assignments: [{ ...assignment }] });
    const emptyWhite = row(871, '   ', true);
    const emptyBlack = { ...row(872, ''),
      assignments: [{ ...assignment, blockingMode: 'daily_limit', dailyLimit: { minutes: 1 } }] };
    const keep = row(873, 'keep-conflict.bd-e2e.test');
    await e.seed({ pro: true, rules: [emptyWhite, emptyBlack, keep], usage: { '872:general': 60 } });
    const page = await e.openOptions();
    const mutate = async (type, payload) => {
      const state = await e.state();
      return message(page, { type, payload: { ...payload,
        expectedGeneration: state.rulesGeneration ?? null,
        expectedRevision: state.ruleRevisions?.[payload.ruleId] ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
    };
    const added = await mutate('rules:add', { blockURL: 'fresh-conflict', redirectURL: '', category: 'social', assignment });
    assert.equal(added.success, true);
    assert.equal(added.syncPending, true, 'the invalid blacklist still reports pending DNR synchronization');
    const allowed = await mutate('rules:add', { blockURL: 'permitted-conflict.bd-e2e.test', redirectURL: '',
      category: 'whitelist', isWhitelist: true, assignment });
    assert.equal(allowed.success, true);
    const updated = await mutate('rules:update', { ruleId: keep.id, blockURL: 'changed-conflict.bd-e2e.test',
      redirectURL: '', category: 'social', assignment });
    assert.equal(updated.success, true);
    const pending = await e.state();
    assert.deepEqual(pending.rules.find(rule => rule.id === emptyWhite.id), emptyWhite);
    assert.deepEqual(pending.rules.find(rule => rule.id === emptyBlack.id), emptyBlack);
    assert.equal(pending.dailyRuleUsage.usageSeconds['872:general'], 60);
    assert.equal(pending.dnr.some(rule => rule.id === emptyBlack.id), false);
    assert.ok(pending.dnr.some(rule => rule.condition.urlFilter === '||fresh-conflict'));
    const repaired = await mutate('rules:update', { ruleId: emptyBlack.id, blockURL: 'repaired-conflict.bd-e2e.test',
      redirectURL: '', category: emptyBlack.category, assignment: emptyBlack.assignments[0] });
    assert.equal(repaired.success, true);
    assert.equal(repaired.syncPending, false);
    const saved = await e.state();
    for (const [blockURL, isWhitelist, code] of [
      ['permitted-conflict', false, 'conflict_whitelist'], ['changed-conflict', true, 'conflict_blacklist']
    ]) {
      const result = await mutate('rules:add', { blockURL, redirectURL: '', category: 'social', isWhitelist, assignment });
      assert.equal(result.success, false);
      assert.equal(result.error.code, code, 'real substring conflicts remain protected');
    }
    const after = await e.state();
    assert.deepEqual(after.rules, saved.rules);
    assert.deepEqual([...after.dnr].sort((a, b) => a.id - b.id), [...saved.dnr].sort((a, b) => a.id - b.id));
    assert.equal(after.dailyRuleUsage.usageSeconds['872:general'], 60);
    assert.deepEqual(after.rules.find(rule => rule.id === emptyWhite.id), emptyWhite);
    await e.assertBlocked('http://fresh-conflict.bd-e2e.test/page', 'always');
    await e.assertBlocked('http://changed-conflict.bd-e2e.test/page', 'always');
    await e.assertBlocked('http://repaired-conflict.bd-e2e.test/page', 'daily_limit');
    const control = await e.newPage('http://keep-conflict.bd-e2e.test/page');
    assert.equal(await control.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
  }
});

urlSafetyScenarios.push({
  id: '88', title: 'Compiled blacklist aliases reject competing mutations and share one native Focus target without losing budgets',
  async run(e) {
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'daily_limit',
      schedule: null, dailyLimit: { minutes: 1 } };
    const row = (id, blockURL, config = {}, category = 'social') => ({ id, blockURL,
      redirectURL: '', category, isWhitelist: false, assignments: [{ ...assignment, ...config }] });
    const plain = 'identity.bd-e2e.test/team';
    const alias = 'https://www.identity.bd-e2e.test:443/team/';
    const rules = [row(881, plain), row(882, alias, { disabledByUser: true }, 'work'),
      row(883, 'http://www.identity.bd-e2e.test:80/team/', {
        listId: 'list-1', blockingMode: 'always', dailyLimit: null
      }, 'news')];
    const usage = { '881:general': 120, '882:general': 180 };
    await e.seed({ pro: true, rules, usage, active: 'list-1' });
    const page = await e.openOptions();
    const mutate = async (type, payload) => {
      const state = await e.state();
      return message(page, { type, payload: { ...payload,
        expectedGeneration: state.rulesGeneration ?? null,
        expectedRevision: state.ruleRevisions?.[payload.ruleId] ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
    };
    const compiled = await page.evaluate(async targets => {
      const api = globalThis.browser || chrome;
      const { createDnrUrlFilter } = await import(api.runtime.getURL('rules/dnrRuleFactory.js'));
      return targets.map(target => createDnrUrlFilter(target));
    }, rules.map(rule => rule.blockURL));
    assert.deepEqual(compiled, Array(3).fill('||identity.bd-e2e.test/team'), 'prove native URL serialization before testing identity');
    const before = await e.state();
    for (const [type, payload] of [
      ['rules:add', { blockURL: alias, redirectURL: 'https://destination.bd-e2e.test/', category: 'social', assignment }],
      ['rules:toggle', { ruleId: 882, listId: 'general' }]
    ]) {
      const result = await mutate(type, payload);
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'rule_already_exists');
    }
    const rejected = await e.state();
    assert.deepEqual(rejected.rules, before.rules);
    assert.deepEqual(rejected.ruleRevisions, before.ruleRevisions);
    assert.equal(rejected.rulesGeneration, before.rulesGeneration);
    assert.deepEqual(rejected.dailyRuleUsage.usageSeconds, usage);

    // A saved disabled alternative remains usable after disabling its rival.
    for (const ruleId of [881, 882]) {
      const result = await mutate('rules:toggle', { ruleId, listId: 'general' });
      assert.equal(result.success, true);
      assert.equal(result.syncPending, false);
    }
    const afterToggle = await e.state();
    assert.deepEqual(afterToggle.dailyRuleUsage.usageSeconds, usage);
    assert.equal(afterToggle.rules[0].assignments[0].disabledByUser, true);
    assert.equal(afterToggle.rules[1].assignments[0].disabledByUser, false);
    assert.equal((await message(page, { type: 'start_focus_session', duration: 5, focusMode: 'blacklist' })).success, true);
    try {
      const focused = await poll(() => e.state(), state => state.dnr.length === 1 && state.dnr[0].id === 883,
        'Focus installs the active profile target for all compiled aliases');
      assert.equal(focused.dnr[0].condition.urlFilter, compiled[0]);
      assert.equal(new URL(focused.dnr[0].action.redirect.url).searchParams.get('reason'), 'focus');
      assert.deepEqual(focused.rules, afterToggle.rules, 'Focus does not merge saved rows');
      assert.deepEqual(focused.dailyRuleUsage.usageSeconds, usage);
      await e.assertBlocked('http://identity.bd-e2e.test/team/item', 'focus');
    } finally {
      assert.equal((await message(page, { type: 'stop_focus_session' })).success, true);
    }
    await poll(() => e.state(), state => state.dnr.length === 1 && state.dnr[0].id === 883 &&
      new URL(state.dnr[0].action.redirect.url).searchParams.get('reason') === 'always',
    'stopping Focus restores the selected profile');
    await e.assertBlocked('http://identity.bd-e2e.test/team/item', 'always');
    const after = await e.state();
    assert.deepEqual(after.rules, afterToggle.rules);
    assert.deepEqual(after.dailyRuleUsage.usageSeconds, usage);
  }
});

urlSafetyScenarios.push({
  id: '89', persistent: true,
  title: 'Native network and SPA redirects share explicit overlap priorities through reorder, restart and Focus',
  async run(e) {
    const assignment = listId => ({ listId, disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null });
    const row = (id, blockURL, destination, listId = 'general') => ({ id, blockURL,
      redirectURL: `http://destination.bd-e2e.test/${destination}`, category: 'social',
      isWhitelist: false, assignments: [assignment(listId)] });
    const broad = row(899, 'precedence.bd-e2e.test/team', 'broad');
    const narrow = row(891, 'precedence.bd-e2e.test/team/item', 'narrow');
    const first = row(898, 'precedence.bd-e2e.test/a*b', 'first');
    const second = row(892, 'precedence.bd-e2e.test/ab*', 'second');
    const aliases = [row(895, 'precedence.bd-e2e.test/team', 'general'),
      row(896, 'https://www.precedence.bd-e2e.test:443/team/', 'profile', 'list-1'),
      row(897, 'precedence.bd-e2e.test/team/item', 'focused-narrow', 'list-2')];
    let page;
    const prove = async (target, winnerId, overlapping = true) => {
      const snapshot = await e.state();
      const matches = await page.evaluate(async ({ target, snapshot }) => {
        const api = globalThis.browser || chrome;
        const { doesUrlMatchBlockRule } = await import(api.runtime.getURL('rules/urlRuleMatcher.js'));
        return snapshot.dnr.filter(dnr => doesUrlMatchBlockRule(target,
          snapshot.rules.find(rule => rule.id === dnr.id).blockURL));
      }, { target, snapshot });
      assert.ok(matches.length >= (overlapping ? 2 : 1), 'prove native-serialized filters overlap before navigation');
      assert.equal(new Set(snapshot.dnr.map(rule => rule.priority)).size, snapshot.dnr.length);
      assert.ok(snapshot.dnr.every(rule => Number.isSafeInteger(rule.priority) && rule.priority >= 100));
      const highest = Math.max(...matches.map(rule => rule.priority));
      assert.deepEqual(matches.filter(rule => rule.priority === highest).map(rule => rule.id), [winnerId]);
      const destination = snapshot.rules.find(rule => rule.id === winnerId).redirectURL;
      const network = await e.newPage(target);
      await poll(() => network.url(), url => url === destination, 'native network redirect chooses the intended destination');
      const spa = await e.newPage('http://precedence.bd-e2e.test/open');
      assert.equal(await spa.evaluate(() => document.querySelector('h1')?.textContent), 'BD E2E fixture');
      await spa.evaluate(path => history.pushState({}, '', path), new URL(target).pathname);
      await poll(() => spa.url(), url => url === destination, 'same-document SPA navigation chooses the same destination');
    };
    for (const phase of [
      { rules: [broad, narrow], target: '/team/item/next', winner: narrow.id },
      { rules: [narrow, broad], target: '/team/item/next', winner: narrow.id },
      { rules: [first, second], target: '/ab/next', winner: first.id },
      { rules: [second, first], target: '/ab/next', winner: second.id, restart: true }
    ]) {
      const usage = Object.fromEntries(phase.rules.map(rule => [`${rule.id}:general`, 40]));
      await e.seed({ pro: true, rules: phase.rules, usage });
      page = await e.openOptions();
      await e.reconcile(page);
      const before = await e.state();
      assert.deepEqual(before.rules, phase.rules);
      await prove('http://precedence.bd-e2e.test' + phase.target, phase.winner);
      if (phase.restart) {
        const signature = rules => [...rules].sort((left, right) => left.id - right.id);
        await e.restart();
        page = await e.openOptions();
        await poll(() => e.state(), state => JSON.stringify(signature(state.dnr)) === JSON.stringify(signature(before.dnr)),
          'a real browser restart preserves the installed priorities without a corrective intent');
        await prove('http://precedence.bd-e2e.test' + phase.target, phase.winner);
      }
      const after = await e.state();
      assert.deepEqual(after.rules, before.rules);
      assert.deepEqual(after.dailyRuleUsage.usageSeconds, usage);
    }
    const usage = { '895:general': 40, '896:list-1': 80, '897:list-2': 20 };
    await e.seed({ pro: true, rules: aliases, usage, active: 'list-1' });
    page = await e.openOptions();
    await e.reconcile(page);
    assert.equal((await message(page, { type: 'start_focus_session', duration: 5, focusMode: 'blacklist' })).success, true);
    try {
      await poll(() => e.state(), state => state.dnr.length === 2 &&
        state.dnr.some(rule => rule.id === 896) && state.dnr.some(rule => rule.id === 897),
      'Focus deduplicates aliases before assigning priorities');
      await prove('http://precedence.bd-e2e.test/team/item/next', 897);
      await prove('http://precedence.bd-e2e.test/team/other', 896, false);
    } finally {
      assert.equal((await message(page, { type: 'stop_focus_session' })).success, true);
    }
    await poll(() => e.state(), state => state.dnr.length === 1 && state.dnr[0].id === 896 && state.dnr[0].priority === 100,
      'stopping Focus restores only the active profile');
    await prove('http://precedence.bd-e2e.test/team/item/next', 896, false);
    const after = await e.state();
    assert.deepEqual(after.rules, aliases);
    assert.deepEqual(after.dailyRuleUsage.usageSeconds, usage);
  }
});

urlSafetyScenarios.push({
  id: '90', title: 'Whitelist validation and aliases preserve native blocking and existing Focus scope',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
    const mutate = async (type, payload) => {
      const state = await e.state();
      return message(page, { type, payload: { ...payload,
        expectedGeneration: state.rulesGeneration ?? null,
        expectedRevision: state.ruleRevisions?.[payload.ruleId] ?? null,
        expectedListRevisions: state.ruleListRevisions || {}
      } });
    };
    const target = 'allowed.bd-e2e.test/team';
    assert.equal((await mutate('rules:add', { blockURL: target, isWhitelist: true, assignment })).success, true);
    const saved = await e.state();
    for (const blockURL of ['www.', 'https://[bad', '*.allowed.bd-e2e.test']) {
      const reply = await mutate('rules:add', { blockURL, isWhitelist: true, assignment });
      assert.equal(reply.success, false); assert.equal(reply.error.code, 'validation_failed');
    }
    const duplicate = await mutate('rules:add', {
      blockURL: 'HTTPS://WWW.allowed.bd-e2e.test:18080/TEAM/?q=1#part', isWhitelist: true, assignment
    });
    assert.equal(duplicate.success, false);
    assert.ok(['redundant_whitelist', 'rule_already_exists'].includes(duplicate.error.code));
    const unchanged = await e.state();
    assert.deepEqual(unchanged.rules, saved.rules);
    assert.deepEqual(unchanged.ruleRevisions, saved.ruleRevisions);
    assert.equal(unchanged.rulesGeneration, saved.rulesGeneration);

    const added = await mutate('rules:add', { blockURL: `other.bd-e2e.test/?next=${target}`,
      redirectURL: '', category: 'social', assignment });
    assert.equal(added.success, true); assert.equal(added.syncPending, false);
    const state = await e.state();
    assert.equal(state.rules.length, 2);
    assert.ok(state.dnr.some(rule => rule.condition.urlFilter === '||other.bd-e2e.test'));
    assert.equal(state.rules.find(rule => rule.isWhitelist).blockURL, target);
    const blocked = await e.newPage('http://other.bd-e2e.test/check');
    await poll(() => blocked.url(), url => url.includes('blocked.html'), 'unrelated query text does not stop native blocking');

    const ids = {};
    for (const [name, url] of [
      ['defaultPort', 'http://allowed.bd-e2e.test/team'],
      ['otherPort', 'http://allowed.bd-e2e.test:18081/team/project'],
      ['outsidePath', 'http://allowed.bd-e2e.test/teamwork']
    ]) ids[name] = await createTab(page, url);
    await poll(() => page.evaluate(async ids => {
      const api = globalThis.browser || chrome;
      return Promise.all(Object.values(ids).map(id => api.tabs.get(id)));
    }, ids), tabs => tabs.every(tab => tab.status === 'complete' && !tab.pendingUrl), 'native control pages are loaded');
    assert.equal((await message(page, { type: 'start_focus_session', duration: 5, focusMode: 'whitelist' })).success, true);
    try {
      await poll(() => tabIds(page), retained => !retained.includes(ids.outsidePath), 'Whitelist keeps its path boundary');
      const retained = await tabIds(page);
      assert.ok(retained.includes(ids.defaultPort));
      assert.ok(retained.includes(ids.otherPort), 'Whitelist port policy remains unchanged');
    } finally {
      assert.equal((await message(page, { type: 'stop_focus_session' })).success, true);
    }
  }
});
