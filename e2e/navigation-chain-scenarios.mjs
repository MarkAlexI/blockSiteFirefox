import assert from 'node:assert/strict';
import { startNavigationHttpFixture } from './navigation-http-fixture.mjs';
import { inBackground } from './scheduled-expiry-probes.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accepts, label) {
  const deadline = Date.now() + 15000;
  let value;
  do { value = await read(); if (accepts(value)) return value; await delay(100); } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const assignment = mode => ({ listId: 'general', disabledByUser: false, blockingMode: mode,
  schedule: null, dailyLimit: mode === 'daily_limit' ? { minutes: 10 } : null });
const rule = (id, blockURL, redirectURL = '', mode = 'always') => ({ id, blockURL, redirectURL,
  category: 'social', isWhitelist: false, assignments: [assignment(mode)] });
const front = page => page.front ? page.front() : page.bringToFront();
const stats = async e => (await e.state(['statistics'])).statistics;
async function fixture(e, run) {
  const server = await startNavigationHttpFixture();
  e.navigationFixture = server;
  try { await run(server); }
  finally {
    try { await attach(e, 'navigation-http-requests', server.requests); }
    finally { e.navigationFixture = null; await server.close(); }
  }
}
const attach = async (e, name, value) => {
  if (e.testInfo) await e.testInfo.attach(name, { contentType: 'application/json', body: JSON.stringify(value) });
  else (e.result.navigationEvidence ||= {})[name] = value;
};

export const navigationChainScenarios = [{
  id: '105', title: 'Navigation chain: real HTTP 301 and 302 returns stop once without inflating redirect statistics',
  async run(e) {
    await fixture(e, async server => {
      const { origin } = server;
      await e.seed({ pro: true, rules: [
        rule(1051, `${origin}/blocked/301`, `${origin}/server/301`),
        rule(1052, `${origin}/blocked/302`, `${origin}/server/302`),
        rule(1053, `${origin}/blocked/safe`, `${origin}/server/safe-301`)
      ] });
      const control = await e.openOptions(); await e.reconcile(control);
      const blockedUrl = await control.evaluate(() => (globalThis.browser || chrome).runtime.getURL('blocked.html'));
      const initial = await stats(e);
      for (const status of [301, 302]) {
        const page = await e.newPage();
        try { await page.goto(`${origin}/blocked/${status}`); }
        catch (error) { if (!/NS_BINDING_ABORTED|net::ERR_ABORTED/.test(error.message)) throw error; }
        await until(() => page.url(), url => url === blockedUrl, `server ${status} ends on the local blocked page`);
        assert.equal(server.requests.filter(item => item.path === `/server/${status}`).length, 1);
      }
      await until(() => stats(e), s => s.totalRedirects === initial.totalRedirects + 2 &&
        s.totalBlocked === initial.totalBlocked + 2, 'one authorized hop and one terminal block per trap');
      const safe = await e.newPage();
      for (let i = 0; i < 2; i++) {
        try { await safe.goto(`${origin}/blocked/safe`); }
        catch (error) { if (!/NS_BINDING_ABORTED|net::ERR_ABORTED/.test(error.message)) throw error; }
        await until(() => safe.url(), url => url === `${origin}/landing`, 'safe 301/302 chain reaches its real landing page');
        await until(() => safe.evaluate(() => document.querySelector('h1')?.textContent),
          text => text === 'BD navigation fixture', 'real landing document is parsed');
        // Observe the real completion before deliberately visiting the same
        // rule again. A completed visit must begin a new independent chain.
        await until(() => control.evaluate(async expected => (await (globalThis.browser || chrome).tabs.query({}))
          .some(tab => tab.url === expected && tab.status === 'complete'), `${origin}/landing`), Boolean, 'native completed landing');
      }
      const final = await until(() => stats(e), s => s.totalRedirects === initial.totalRedirects + 4, 'safe revisits each count once');
      assert.equal(final.totalBlocked, initial.totalBlocked + 2);
      await attach(e, 'server-redirect-chain', { requests: server.requests, initial, final });
    });
  }
}, {
  id: '106', title: 'Navigation chain: SPA pushState, replaceState, hash, Back and Forward enforce only the current URL',
  async run(e) {
    await fixture(e, async ({ origin }) => {
      await e.seed({ pro: true, rules: [rule(1061, `${origin}/spa/blocked`)] });
      let control = await e.openOptions(); await e.reconcile(control);
      const blockedPrefix = await control.evaluate(() => (globalThis.browser || chrome).runtime.getURL('blocked.html'));
      for (const method of ['pushState', 'replaceState']) {
        const page = await e.newPage(`${origin}/spa/safe`); await front(page);
        await page.evaluate(({ method }) => history[method]({}, '', '/spa/blocked'), { method });
        await until(() => page.url(), url => url.startsWith(blockedPrefix), `native ${method} is enforced`);
      }
      const page = await e.newPage(`${origin}/spa/safe`); await front(page);
      await page.evaluate(() => { history.pushState({}, '', '/spa/safe-next'); history.replaceState({}, '', '/spa/safe-replaced'); location.hash = 'spa/blocked'; });
      await until(() => page.url(), url => url === `${origin}/spa/safe-replaced#spa/blocked`, 'hash remains part of the allowed document');
      await page.evaluate(() => history.back());
      await until(() => page.url(), url => url === `${origin}/spa/safe-replaced`, 'hash Back');
      await page.evaluate(() => history.forward());
      await until(() => page.url(), url => url === `${origin}/spa/safe-replaced#spa/blocked`, 'hash Forward');
      for (const direction of ['back', 'forward']) {
        await e.seed({ pro: true, rules: [] });
        const historyPage = await e.newPage(`${origin}/spa/safe`); await front(historyPage);
        await historyPage.evaluate(() => { history.pushState({}, '', '/spa/blocked-history'); history.pushState({}, '', '/spa/current'); });
        if (direction === 'forward') {
          await historyPage.evaluate(() => history.go(-2));
          await until(() => historyPage.url(), url => url === `${origin}/spa/safe`, 'safe history cursor');
        }
        await e.seed({ pro: true, rules: [rule(1061, `${origin}/spa/blocked`)] });
        control = await e.openOptions(); await e.reconcile(control); await front(historyPage);
        await historyPage.evaluate(direction => history[direction](), direction);
        await until(() => historyPage.url(), url => url.startsWith(blockedPrefix), `blocked history ${direction}`);
      }
      // Hold delivery of an actual native tab read inside the real enforcer.
      // A newer allowed URL must supersede that delayed blocked decision.
      const pending = await e.newPage(`${origin}/spa/safe`); await front(pending);
      const targetId = await control.evaluate(async url => (await (globalThis.browser || chrome).tabs.query({})).find(tab => tab.url === url)?.id, `${origin}/spa/safe`);
      assert.ok(Number.isInteger(targetId));
      await inBackground(e, (view, { id, namespace }) => {
        const api = view[namespace], original = api.tabs.get;
        const probe = view.__bdSpaNavigationHold = { original, claimed: false, captured: false, returned: false };
        api.tabs.get = async function(tabId, ...args) {
          const hold = tabId === id && !probe.claimed && new view.Error().stack.includes('spaNavigationEnforcer');
          if (hold) probe.claimed = true;
          const result = await original.call(this, tabId, ...args);
          if (hold) {
            await new view.Promise(resolve => { probe.release = resolve; probe.captured = true; }); probe.returned = true;
          }
          return result;
        };
      }, { id: targetId, namespace: e.worker ? 'chrome' : 'browser' });
      try {
        await pending.evaluate(() => history.pushState({}, '', '/spa/blocked-delayed'));
        await until(() => inBackground(e, view => view.__bdSpaNavigationHold.captured), Boolean, 'native enforcer read held');
        await pending.evaluate(() => history.replaceState({}, '', '/spa/safe-newer#current'));
        await delay(200);
        await inBackground(e, view => view.__bdSpaNavigationHold.release());
        await until(() => inBackground(e, view => view.__bdSpaNavigationHold.returned), Boolean, 'native enforcer read returned');
        await delay(200);
        assert.equal(await pending.url(), `${origin}/spa/safe-newer#current`);
      } finally {
        await inBackground(e, (view, { namespace }) => {
          const probe = view.__bdSpaNavigationHold; probe.release?.(); view[namespace].tabs.get = probe.original; delete view.__bdSpaNavigationHold;
        }, { namespace: e.worker ? 'chrome' : 'browser' });
      }
      await attach(e, 'spa-history-current-url', { finalUrl: await pending.url(), methods: ['pushState', 'replaceState', 'hash', 'back', 'forward'] });
    });
  }
}, {
  id: '107', title: 'Navigation chain: Daily Limits retain spent budgets through rapid SPA, hash and history transitions',
  async run(e) {
    await fixture(e, async ({ origin }) => {
      await e.seed({ pro: true, rules: [rule(1071, `${origin}/daily/a`, '', 'daily_limit'),
        rule(1072, `${origin}/daily/b`, '', 'daily_limit')], usage: { '1071:general': 40, '1072:general': 35 } });
      const control = await e.openOptions(); await e.reconcile(control);
      const page = await e.newPage(`${origin}/daily/a`); await front(page);
      const usage = async () => (await e.state()).dailyRuleUsage;
      const first = await until(usage, s => s?.lastSample?.assignmentKeys.includes('1071:general'), 'first real foreground segment');
      await page.evaluate(async () => {
        for (let i = 0; i < 15; i++) { location.hash = String(i); await new Promise(resolve => setTimeout(resolve, 200)); }
      });
      const hashes = await until(usage, s => (s?.usageSeconds['1071:general'] ?? 0) >= 42, 'rapid same-rule changes retain elapsed seconds');
      await page.evaluate(() => history.pushState({}, '', '/daily/b'));
      await until(usage, s => s.lastSample.assignmentKeys.includes('1072:general'), 'second rule owns the next segment');
      await delay(1300);
      await page.evaluate(() => history.replaceState({}, '', '/daily/b?next=1'));
      await until(usage, s => (s.usageSeconds['1072:general'] ?? 0) >= 36, 'second rule accrues its own active time');
      await page.evaluate(() => history.back());
      await until(usage, s => s.lastSample.assignmentKeys.includes('1071:general'), 'Back restores the first budget');
      await delay(1300);
      await page.evaluate(() => history.forward());
      const final = await until(usage, s => s.lastSample.assignmentKeys.includes('1072:general'), 'Forward restores the second budget');
      assert.ok(final.usageSeconds['1071:general'] >= hashes.usageSeconds['1071:general']);
      assert.ok(final.usageSeconds['1072:general'] >= 36);
      const elapsed = (final.lastSample.timestamp - first.lastSample.timestamp) / 1000;
      const added = final.usageSeconds['1071:general'] - first.usageSeconds['1071:general'] +
        final.usageSeconds['1072:general'] - first.usageSeconds['1072:general'];
      const spentMs = state => ['1071:general', '1072:general'].reduce((sum, key) =>
        sum + (state.usageSeconds[key] || 0) * 1000 + (state.usageRemaindersMs?.[key] || 0), 0);
      const addedMilliseconds = spentMs(final) - spentMs(first);
      assert.equal(addedMilliseconds, final.lastSample.timestamp - first.lastSample.timestamp,
        'all verified foreground milliseconds belong to exactly one budget');
      await page.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          history.replaceState({}, '', i % 2 ? '/daily/b' : '/daily/a');
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      });
      const alternating = await until(usage, s => s.usageSeconds['1071:general'] >= final.usageSeconds['1071:general'] + 1 &&
        s.usageSeconds['1072:general'] >= final.usageSeconds['1072:general'] + 1, 'rapid cross-rule visits preserve both budgets');
      assert.equal(spentMs(alternating) - spentMs(final), alternating.lastSample.timestamp - final.lastSample.timestamp,
        'rapid cross-rule visits neither duplicate nor discard elapsed milliseconds');
      await attach(e, 'daily-navigation-budgets', { first, hashes, final, alternating, elapsed, added, addedMilliseconds });
    });
  }
}];
