import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { send, addUi, assignment, dailyRule, basicPayload, paidPayload,
  TEST_KEY, SITE, delay, poll, equalEventually } from './fixtures.mjs';

export const scenarios = [];
const test = (id, title, run, extra = {}) => scenarios.push({ id, title, run, ...extra });
const rows = '#rules-container tr[data-rule-id]';
const ids = state => state.dnr.map(rule => rule.id).sort((a, b) => a - b);
const waitRules = (e, length) => equalEventually(async () => (await e.state()).rules.length, length, 'rule count');
const waitUsage = (e, key, seconds) => equalEventually(async () => (await e.state()).dailyRuleUsage.usageSeconds[key], seconds, `usage ${key}`);
const waitDnr = (e, expected) => equalEventually(async () => ids(await e.state()), expected, 'native DNR ids');
const waitRows = (page, count) => equalEventually(() => page.count(rows), count, 'Options row count');

test('01', 'two Options callers preserve concurrent additions, UI state and real DNR blocking', async e => {
  const a = await e.openOptions();
  const b = await e.openOptions();
  const responses = await Promise.all([
    send(a, 'rules:add', basicPayload('one.bd-e2e.test')),
    send(b, 'rules:add', basicPayload('two.bd-e2e.test'))
  ]);
  assert.equal(responses.every(item => item.success), true, JSON.stringify(responses));
  await waitRules(e, 2);
  const state = await e.state();
  assert.equal(new Set(state.rules.map(rule => rule.id)).size, 2);
  await waitDnr(e, state.rules.map(rule => rule.id).sort((x, y) => x - y));
  await waitRows(a, 2); await waitRows(b, 2);
  await e.assertBlocked('http://one.bd-e2e.test/page');
  await e.assertBlocked('http://two.bd-e2e.test/page');
});

test('02', 'UI editing splits a shared Daily Limit target and preserves its exhausted budget', async e => {
  const rule = dailyRule(); rule.assignments.push(assignment('list-1'));
  await e.seed({ rules: [rule], usage: { '21:general': 100, '21:list-1': 840 }, active: 'list-1' });
  const a = await e.openOptions(); const b = await e.openOptions();
  await e.reconcile(a);
  await a.click('tr[data-rule-id="21"][data-assignment-list-id="list-1"] .actions button:first-child');
  const edit = '#rules-container tr:has(.save-btn)';
  await a.fill(`${edit} td:nth-child(2) input`, 'http://safe.bd-e2e.test/study');
  await a.click(`${edit} .save-btn`);
  await waitRules(e, 2);
  const state = await e.state(); const split = state.rules.find(item => item.id !== 21);
  await waitUsage(e, `${split.id}:list-1`, 840);
  assert.equal(state.dailyRuleUsage.usageSeconds['21:list-1'], undefined);
  assert.equal(state.dailyRuleUsage.usageSeconds['21:general'], 100);
  assert.deepEqual(state.pendingDailyUsageRemaps, []);
  await waitDnr(e, [split.id]); await waitRows(a, 1); await waitRows(b, 1);
  await b.hasClass(`${rows} .daily-limit-status`, 'limit-reached');
  const page = await e.newPage(`${SITE}/watch`);
  await equalEventually(() => page.url(), 'http://safe.bd-e2e.test/study', 'native redirect');
  await equalEventually(() => page.text('h1'), 'BD E2E fixture', 'redirect destination');
});

test('03', 'two Options split and move assignments before legacy migration without granting a new budget', async e => {
  const rule = dailyRule(); rule.assignments.push(assignment('list-1'));
  await e.seed({ rules: [rule], active: 'list-2', rawUsage: { version: 1, usageSeconds: { '21': 840 }, lastSample: null } });
  const a = await e.openOptions(); const b = await e.openOptions();
  const responses = await Promise.all([
    send(a, 'rules:update', { ruleId: 21, assignmentListId: 'list-1', blockURL: rule.blockURL,
      redirectURL: 'http://safe.bd-e2e.test/study', assignment: assignment('list-1') }),
    send(b, 'rules:update', { ruleId: 21, assignmentListId: 'general', blockURL: rule.blockURL,
      redirectURL: '', assignment: assignment('list-2') })
  ]);
  assert.equal(responses.every(response => response.success), true, JSON.stringify(responses));
  const state = await e.state(); assert.equal(state.rules.length, 2);
  const study = state.rules.find(item => item.assignments.some(a => a.listId === 'list-1'));
  const work = state.rules.find(item => item.assignments.some(a => a.listId === 'list-2'));
  assert.notEqual(study.id, work.id);
  assert.equal(state.dailyRuleUsage.usageSeconds[`${study.id}:list-1`], 840);
  assert.equal(state.dailyRuleUsage.usageSeconds[`${work.id}:list-2`], 840);
  assert.deepEqual(state.pendingDailyUsageRemaps, []);
  await waitDnr(e, [work.id]); await e.assertBlocked(`${SITE}/work`, 'daily_limit');
});

test('04', 'UI deletion and JSON import update both Options, usage and actual navigation', async e => {
  await e.seed({ rules: [dailyRule()], usage: { '21:general': 840 } });
  const a = await e.openOptions(); const b = await e.openOptions();
  await e.reconcile(a); await a.click('tr[data-rule-id="21"] .delete-btn');
  await waitRules(e, 0); await waitDnr(e, []); await waitRows(b, 0);
  assert.deepEqual((await e.state()).dailyRuleUsage.usageSeconds, {});
  const { assignment: always, ...target } = basicPayload('imported.bd-e2e.test');
  const backup = { rules: [{ id: 99, ...target, isWhitelist: false, assignments: [always] }] };
  const file = path.join(e.root, 'bd-e2e-backup.json');
  await writeFile(file, JSON.stringify(backup));
  // Native WebDriver file selection; no synthetic change event or API double.
  await (await a.element('#importFileInput')).sendKeys(file);
  await waitRules(e, 1); await waitDnr(e, [1]);
  await poll(() => a.text(rows), text => text?.includes('imported.bd-e2e.test'), 'import in first Options');
  await poll(() => b.text(rows), text => text?.includes('imported.bd-e2e.test'), 'import in second Options');
  assert.deepEqual((await e.state()).dailyRuleUsage.usageSeconds, {});
  await e.assertBlocked('http://imported.bd-e2e.test/page');
});

test('05', 'browser restart recovers a durable remap journal before enforcing the exhausted budget', async e => {
  await e.seed({ rules: [dailyRule()], usage: { '21:list-1': 840 }, pending: [
    { oldRuleId: 21, oldListId: 'list-1', newRuleId: 21, newListId: 'general' }
  ] });
  // Durable fixture at the post-commit/pre-recovery boundary; clean restart.
  await e.restart(); const page = await e.openOptions();
  await equalEventually(async () => (await e.state()).pendingDailyUsageRemaps, [], 'journal recovered');
  await waitUsage(e, '21:general', 840);
  assert.equal((await e.state()).dailyRuleUsage.usageSeconds['21:list-1'], undefined);
  await waitDnr(e, [21]); await page.hasClass(`${rows} .daily-limit-status`, 'limit-reached');
  await e.assertBlocked(`${SITE}/recovered`, 'daily_limit');
}, { persistent: true });

test('06', 'browser startup migrates mixed v1 counters using the larger elapsed time', async e => {
  const rule = dailyRule(); rule.assignments.push(assignment('list-1'));
  await e.seed({ rules: [rule], rawUsage: {
    version: 1, usageSeconds: { '21': 840, '21:general': 10, '21:list-1': 900 }, lastSample: null
  } });
  await e.restart(); await e.openOptions();
  await equalEventually(async () => (await e.state()).dailyRuleUsage.usageSeconds,
    { '21:general': 840, '21:list-1': 900 }, 'mixed v1 migration');
  await waitDnr(e, [21]); await e.assertBlocked(`${SITE}/migrated`, 'daily_limit');
}, { persistent: true });

test('07', 'real foreground accounting and deadline alarm exhaust a configured Daily Limit', async e => {
  const options = await e.openOptions(); await addUi(options, 'usage.bd-e2e.test', { dailyMinutes: 1 });
  const rule = (await e.state()).rules[0]; const usage = (await e.state()).dailyRuleUsage;
  await e.writeLocal({ dailyRuleUsage: { ...usage, usageSeconds: { [`${rule.id}:general`]: 55 }, lastSample: null } });
  await e.reconcile(options);
  const browsing = await e.newPage(`${SITE}/foreground`); await browsing.front();
  await equalEventually(() => browsing.text('h1'), 'BD E2E fixture', 'real foreground page');
  // Real wall clock and native browser.alarms. Storage reads stay in background.
  await poll(async () => (await e.state()).dailyRuleUsage.usageSeconds[`${rule.id}:general`],
    value => value >= 60, 'budget exhausted by native alarm', 75_000);
  await waitDnr(e, [rule.id]); await e.assertBlocked(`${SITE}/after-budget`, 'daily_limit');
});

test('08', 'a hidden tab pauses accounting and foreground resume charges only visible time', async e => {
  await e.seed({ rules: [dailyRule()], usage: { '21:general': 100 } });
  const options = await e.openOptions(); await e.reconcile(options);
  const browsing = await e.newPage(`${SITE}/visibility`); await browsing.front();
  await equalEventually(async () => (await e.state()).dailyRuleUsage.lastSample?.assignmentKeys, ['21:general'], 'visible segment');
  await options.front();
  await equalEventually(() => browsing.evaluate(() => document.visibilityState), 'hidden', 'native tab visibility');
  await equalEventually(async () => (await e.state()).dailyRuleUsage.lastSample?.assignmentKeys, [], 'paused segment');
  const paused = (await e.state()).dailyRuleUsage.usageSeconds['21:general'];
  await delay(6000); // This measured interval is the assertion target.
  assert.equal((await e.state()).dailyRuleUsage.usageSeconds['21:general'], paused);
  await browsing.front();
  await equalEventually(async () => (await e.state()).dailyRuleUsage.lastSample?.assignmentKeys, ['21:general'], 'resumed segment');
  await delay(2000); await options.front();
  await poll(async () => (await e.state()).dailyRuleUsage.usageSeconds['21:general'], value => value > paused, 'visible elapsed time charged');
  assert.ok((await e.state()).dailyRuleUsage.usageSeconds['21:general'] - paused < 6);
  assert.deepEqual((await e.state()).dnr, []);
});

test('09', 'UI activation waits for verification while Free actions remain available in another Options', async e => {
  await e.seed({ pro: false }); const a = await e.openOptions(); const b = await e.openOptions();
  const calls = e.verificationCalls.length; e.holdVerification();
  await a.click('#proBtn'); await a.fill('#license-key-input', TEST_KEY); await a.click('#license-submit-btn');
  try {
    await equalEventually(() => e.verificationCalls.length, calls + 1, 'native background verification observed', 5000);
    assert.equal((await send(b, 'rules:add', basicPayload('free.bd-e2e.test'))).success, true);
    const rejected = await send(b, 'rules:add', paidPayload('paid.bd-e2e.test'));
    assert.equal(rejected.success, false); assert.equal(rejected.error.code, 'pro_required');
    assert.equal((await e.state()).credentials.isPro, false);
  } finally { e.releaseVerification(); }
  await equalEventually(async () => (await e.state()).credentials.isPro, true, 'activation completed');
  assert.equal((await e.state()).credentials.licenseKey, TEST_KEY);
  await equalEventually(() => a.evaluate(() => document.querySelector('#proWrapper').hasAttribute('inert')), true, 'panel collapsed');
  await equalEventually(() => a.evaluate(() => document.activeElement?.id), 'proBtn', 'focus returned');
  await b.enabled('#add-whitelist-rule');
  assert.equal((await send(b, 'rules:add', paidPayload('paid.bd-e2e.test'))).success, true);
  await waitRules(e, 2);
  await waitDnr(e, [(await e.state()).rules.find(rule => rule.blockURL === 'free.bd-e2e.test').id]);
});

test('10', 'UI logout propagates to both Options and rejects subsequent paid intents without reload', async e => {
  const a = await e.openOptions(); const b = await e.openOptions();
  await a.click('#proBtn'); await a.click('#log-out-btn');
  await equalEventually(async () => (await e.state()).credentials.isPro, false, 'Free credentials');
  await a.enabled('#add-whitelist-rule', false); await b.enabled('#add-whitelist-rule', false);
  const paid = await send(b, 'rules:add', paidPayload('denied.bd-e2e.test'));
  assert.equal(paid.success, false); assert.equal(paid.error.code, 'pro_required');
  await addUi(b, 'allowed-free.bd-e2e.test'); await waitRules(e, 1);
  const state = await e.state(); assert.equal(state.credentials.licenseKey, null);
  await waitDnr(e, [state.rules[0].id]); await e.assertBlocked('http://allowed-free.bd-e2e.test/page');
});

test('11', 'a paid commit begun before logout finishes before Free credentials are saved', async e => {
  const a = await e.openOptions(); const b = await e.openOptions();
  await b.evaluate(() => {
    window.bdE2E = { order: [], response: null };
    const listener = (changes, area) => {
      if (area === 'local' && changes.rules?.newValue?.some(rule => rule.blockURL === 'ordered.bd-e2e.test')) {
        if (window.bdE2E.order.includes('rules')) return;
        window.bdE2E.order.push('rules');
        browser.runtime.sendMessage({ type: 'logout_pro' }).then(response => { window.bdE2E.response = response; });
      }
      if (area === 'sync' && changes.credentials?.newValue?.isPro === false) window.bdE2E.order.push('free');
    };
    browser.storage.onChanged.addListener(listener); window.bdE2E.listener = listener;
  });
  const paid = await send(a, 'rules:add', paidPayload('ordered.bd-e2e.test'));
  assert.equal(paid.success, true, JSON.stringify(paid));
  await equalEventually(() => b.evaluate(() => window.bdE2E.response?.success), true, 'ordered logout response');
  assert.deepEqual(await b.evaluate(() => window.bdE2E.order), ['rules', 'free']);
  await b.evaluate(() => browser.storage.onChanged.removeListener(window.bdE2E.listener));
  const state = await e.state(); assert.equal(state.credentials.isPro, false);
  assert.equal(state.rules[0].assignments[0].blockingMode, 'daily_limit'); assert.deepEqual(state.dnr, []);
  const rejected = await send(b, 'rules:add', paidPayload('later.bd-e2e.test'));
  assert.equal(rejected.error.code, 'pro_required');
});

test('12', 'trusted Legacy keeps advanced controls and paid rule access after UI logout', async e => {
  await e.seed({ legacy: true }); const a = await e.openOptions(); const b = await e.openOptions();
  await a.click('#proBtn'); await a.click('#log-out-btn');
  await equalEventually(async () => (await e.state()).credentials.isPro, false, 'Legacy logout');
  await b.enabled('#add-whitelist-rule'); await addUi(b, 'legacy.bd-e2e.test', { dailyMinutes: 10 });
  const state = await e.state(); assert.equal(state.credentials.installationDate, '2024-01-01T00:00:00.000Z');
  assert.equal(state.credentials.licenseKey, null); assert.equal(state.rules[0].assignments[0].blockingMode, 'daily_limit');
  assert.deepEqual(state.dnr, []);
});

test('13', 'a temporary verification server error preserves Pro and subsequent paid actions', async e => {
  const a = await e.openOptions(); const b = await e.openOptions(); const calls = e.verificationCalls.length;
  e.verificationHandler = async () => ({ status: 500, body: { error: 'E2E temporary failure' } });
  await a.click('#proBtn'); await a.click('#force-sync-btn');
  await poll(() => e.verificationCalls.length, count => count > calls, 'mock 500 observed');
  await a.enabled('#force-sync-btn');
  const state = await e.state(); assert.equal(state.credentials.isPro, true); assert.equal(state.credentials.licenseKey, TEST_KEY);
  await b.enabled('#add-whitelist-rule');
  assert.equal((await send(b, 'rules:add', paidPayload('retained-pro.bd-e2e.test'))).success, true);
  await waitRules(e, 1); assert.deepEqual((await e.state()).dnr, []);
});
