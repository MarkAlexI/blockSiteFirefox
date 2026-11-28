import assert from 'node:assert/strict';
import { startNavigationCacheFixture } from './navigation-cache-fixture.mjs';
import { inBackground } from './scheduled-expiry-probes.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accepts, label) {
  const deadline = Date.now() + 15000;
  let value;
  do { value = await read(); if (accepts(value)) return value; await delay(100); } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const rule = (id, blockURL, redirectURL = '', minutes = null) => ({ id, blockURL, redirectURL,
  category: 'social', isWhitelist: false, assignments: [{ listId: 'general', disabledByUser: false,
    blockingMode: minutes === null ? 'always' : 'daily_limit', schedule: null,
    dailyLimit: minutes === null ? null : { minutes } }] });
const front = page => page.front ? page.front() : page.bringToFront();
const attach = async (e, name, value) => {
  if (e.testInfo) await e.testInfo.attach(name, { contentType: 'application/json', body: JSON.stringify(value) });
  else (e.result.navigationBoundaryEvidence ||= {})[name] = value;
};
async function fixture(e, run) {
  const server = await startNavigationCacheFixture(); e.navigationFixture = server;
  try { await run(server); }
  finally {
    try { await attach(e, 'boundary-http-requests', server.requests); }
    finally { e.navigationFixture = null; await server.close(); }
  }
}
async function configure(e, rules, usage) {
  await e.seed({ pro: true, rules, ...(usage ? { usage } : {}) });
  const control = await e.openOptions(); await e.reconcile(control);
  return { control, blocked: await control.evaluate(() => (globalThis.browser || chrome).runtime.getURL('blocked.html')) };
}

export const navigationBoundaryScenarios = [{
  id: '109', title: 'Navigation boundary: real site service worker and CacheStorage cannot bypass active website rules',
  async run(e) {
    await fixture(e, async server => {
      const { origin } = server;
      await configure(e, []);
      const page = await e.newPage(`${origin}/cache/sw/prime`); await front(page);
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/cache/sw/worker.js');
        await navigator.serviceWorker.ready;
      });
      await until(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
        value => value === `${origin}/cache/sw/worker.js`, 'the real site worker controls the document');
      for (const [path, source] of [['cached', 'cache-storage'], ['generated', 'service-worker-response']]) {
        await page.goto(`${origin}/cache/sw/${path}`);
        assert.equal(await page.evaluate(() => document.body.dataset.source), source,
          'positive control: the response really came from the site worker');
        assert.equal(server.requests.filter(request => request.path === `/cache/sw/${path}`).length, 0,
          'positive control: no server document request served the worker response');
      }
      await page.goto(`${origin}/cache/sw/prime`);
      const { blocked } = await configure(e, [rule(1091, `${origin}/cache/sw/cached`), rule(1092, `${origin}/cache/sw/generated`)]);
      for (const path of ['cached', 'generated']) {
        await page.goto(`${origin}/cache/sw/prime`); await front(page);
        assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), `${origin}/cache/sw/worker.js`);
        try { await page.goto(`${origin}/cache/sw/${path}`); }
        catch (error) { if (!(await page.url()).startsWith(blocked)) throw error; }
        await until(() => page.url(), url => url.startsWith(blocked), `active rule protects the worker ${path} response`);
      }
      await page.goto(`${origin}/cache/sw/prime`);
      await configure(e, [rule(1093, `${origin}/cache/sw/cached`, '', 1)], { '1093:general': 60 });
      try { await page.goto(`${origin}/cache/sw/cached`); }
      catch (error) { if (!(await page.url()).startsWith(blocked)) throw error; }
      await until(() => page.url(), url => url.startsWith(blocked), 'an exhausted Daily Limit also protects a worker response');
      await attach(e, 'site-worker-control', { origin, sources: ['cache-storage', 'service-worker-response'],
        protected: ['always/cached', 'always/generated', 'daily-limit/cached'], finalUrl: await page.url() });
    });
  }
}, {
  id: '110', title: 'Navigation boundary: confirmed BFCache restore rechecks a newly active blocking rule',
  async run(e) {
    await fixture(e, async ({ origin }) => {
      const key = '1102:general';
      const { control } = await configure(e, [rule(1102, `${origin}/cache/history/`, '', 10)], { [key]: 40 });
      const page = await e.newPage(`${origin}/cache/history/a`); await front(page);
      const usage = async () => (await e.state()).dailyRuleUsage;
      const milliseconds = state => (state.usageSeconds[key] || 0) * 1000 + (state.usageRemaindersMs?.[key] || 0);
      const first = await until(usage, state => state.lastSample?.assignmentKeys.includes(key), 'the visible history document owns its real daily budget');
      await delay(1100);
      const original = await page.evaluate(() => window.__bdHistoryDocument);
      await page.goto(`${origin}/cache/history/b`);
      await page.evaluate(() => history.back());
      const positive = await until(() => page.evaluate(() => {
        const events = JSON.parse(sessionStorage.getItem('bd-history-events') || '[]');
        return { url: location.href, document: window.__bdHistoryDocument, last: events.at(-1) };
      }), value => value.url === `${origin}/cache/history/a` && value.last?.path === '/cache/history/a', 'Back reaches the original history entry');
      assert.equal(positive.last.persisted, true, 'positive control: this is a genuine BFCache restore');
      assert.deepEqual(positive.document, original, 'the restored document was not reloaded');
      await until(usage, state => milliseconds(state) >= milliseconds(first) + 1000, 'positive control: real foreground time was charged');
      await page.goto(`${origin}/cache/history/b`);
      const before = await usage(), snapshot = await e.state();
      const added = await control.evaluate(async ({ origin, snapshot }) => (globalThis.browser || chrome).runtime.sendMessage({
        type: 'rules:add', payload: { blockURL: `${origin}/cache/history/a`, redirectURL: '', category: 'social',
          assignment: { listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null },
          expectedGeneration: snapshot.rulesGeneration ?? null, expectedListRevisions: snapshot.ruleListRevisions || {} }
      }), { origin, snapshot });
      assert.equal(added.success, true); await e.reconcile(control);
      const blocked = await control.evaluate(() => (globalThis.browser || chrome).runtime.getURL('blocked.html'));
      await front(page); await page.evaluate(() => history.back());
      await until(() => page.url(), url => url.startsWith(blocked), 'the rule applies on a cached history restore');
      const after = await usage();
      assert.ok(milliseconds(after) >= milliseconds(before), 'BFCache enforcement never resets the spent daily budget');
      assert.ok(milliseconds(after) - milliseconds(before) <= after.lastSample.timestamp - before.lastSample.timestamp,
        'a restored document cannot charge more than the elapsed timeline');
      await page.goto(`${origin}/cache/history/b`);
      const events = await page.evaluate(() => JSON.parse(sessionStorage.getItem('bd-history-events') || '[]'));
      const restores = events.filter(event => event.path === '/cache/history/a' && event.persisted && event.token === original.token);
      assert.equal(restores.length, 2, 'both the unprotected and protected visit restored the same cached document');
      await attach(e, 'bfcache-restores', { original, events, first, before, after });
    });
  }
}, {
  id: '111', title: 'Navigation boundary: duplicate redirect authorization counts once and an unloaded document cannot redirect a newer visit',
  async run(e) {
    await fixture(e, async ({ origin }) => {
      const { control } = await configure(e, [rule(1111, `${origin}/redirect-source`, `${origin}/redirect-target`)]);
      const namespace = e.worker ? 'chrome' : 'browser';
      const install = async () => inBackground(e, (view, { namespace }) => {
        const api = view[namespace];
        const probe = view.__bdRedirectBoundary = { original: api.tabs.get, requests: [], claimed: false, captured: false };
        probe.listener = (message, sender) => {
          if (message.type === 'record_redirect') probe.requests.push({ message, url: sender.url, documentId: sender.documentId });
        };
        api.runtime.onMessage.addListener(probe.listener);
        api.tabs.get = async function(...args) {
          const hold = !probe.claimed && new view.Error().stack.includes('redirectAuthorization.js');
          if (hold) probe.claimed = true;
          const result = await probe.original.apply(this, args);
          if (hold) await new view.Promise(resolve => { probe.release = resolve; probe.captured = true; });
          return result;
        };
      }, { namespace });
      const remove = async () => inBackground(e, (view, { namespace }) => {
        const probe = view.__bdRedirectBoundary;
        if (!probe) return;
        probe.release?.(); view[namespace].tabs.get = probe.original;
        view[namespace].runtime.onMessage.removeListener(probe.listener); delete view.__bdRedirectBoundary;
      }, { namespace });
      const statistics = async () => (await e.state(['statistics'])).statistics;
      await install();
      try {
        const before = await statistics();
        const page = await e.newPage(`${origin}/redirect-source`);
        await until(() => inBackground(e, view => view.__bdRedirectBoundary.captured), Boolean, 'native redirect authorization is held');
        const request = await inBackground(e, view => view.__bdRedirectBoundary.requests[0].message);
        await page.evaluate(({ message, namespace }) => {
          const api = globalThis[namespace], original = api.tabs.getCurrent;
          const probe = window.__bdRedirectPage = { original, captured: false, replies: null };
          api.tabs.getCurrent = async function(...args) {
            const native = await original.apply(this, args);
            await new Promise(resolve => { probe.release = resolve; probe.captured = true; }); return native;
          };
          Promise.all([api.runtime.sendMessage(message), api.runtime.sendMessage(message)])
            .then(replies => { probe.replies = replies; }, error => { probe.error = String(error); });
        }, { message: request, namespace });
        await inBackground(e, view => view.__bdRedirectBoundary.release());
        const duplicates = await until(() => page.evaluate(() => window.__bdRedirectPage), value => value.replies || value.error, 'duplicate native message replies');
        assert.equal(duplicates.error, undefined);
        assert.ok(duplicates.replies.every(reply => reply.success === true && reply.to === `${origin}/redirect-target`));
        const after = await until(statistics, value => value.totalRedirects >= before.totalRedirects + 1, 'the authorized redirect statistic is saved');
        await attach(e, 'duplicate-authorization-probe', { before, after, replies: duplicates.replies,
          requests: await inBackground(e, view => view.__bdRedirectBoundary.requests),
          guard: await control.evaluate(async () => (globalThis.browser || chrome).storage.session.get('redirectNavigationChainsV1')) });
        assert.equal(after.totalRedirects - before.totalRedirects, 1);
        assert.equal(after.totalBlocked - before.totalBlocked, 0);
        await until(() => page.evaluate(() => window.__bdRedirectPage.captured), Boolean, 'the final native tab check is held');
        await page.evaluate(() => window.__bdRedirectPage.release());
        await until(() => page.url(), url => url === `${origin}/redirect-target`, 'the authorized redirect completes once');
        await attach(e, 'duplicate-authorization', { before, after, replies: duplicates.replies });
      } finally { await remove(); }
      await install();
      try {
        const before = await statistics();
        const page = await e.newPage(`${origin}/redirect-source`);
        await until(() => inBackground(e, view => view.__bdRedirectBoundary.captured), Boolean, 'the old document is awaiting a real authorization result');
        await page.goto(`${origin}/newer-allowed-visit`);
        await inBackground(e, view => view.__bdRedirectBoundary.release());
        await delay(300);
        assert.equal(await page.url(), `${origin}/newer-allowed-visit`);
        const after = await statistics();
        assert.equal(after.totalRedirects, before.totalRedirects);
        assert.equal(after.totalBlocked, before.totalBlocked);
        await attach(e, 'unloaded-authorization', { before, after, finalUrl: await page.url() });
      } finally { await remove(); }
      assert.ok(control);
    });
  }
}];

// Firefox's native HTTP proxy preserves the browser cache. The Chromium route
// harness disables HTTP caching, so that variant must use a separate native
// cache backend before registering this scenario.
export const warmRedirectScenarios = [{
  id: '108', title: 'Navigation boundary: warm HTTP 301 and 302 cache still obeys a newly active website rule',
  async run(e) {
    await fixture(e, async server => {
      const { origin } = server; await configure(e, []);
      const page = await e.newPage();
      for (const status of [301, 302]) {
        const url = `${origin}/cache/redirect/${status}`, landing = `${origin}/cache/landing/${status}`;
        await page.goto(url); assert.equal(await page.url(), landing);
        const before = server.requests.filter(request => request.path === `/cache/redirect/${status}`).length;
        await page.goto(`${origin}/cache/neutral`); await page.goto(url);
        assert.equal(await page.url(), landing);
        assert.equal(server.requests.filter(request => request.path === `/cache/redirect/${status}`).length, before,
          'positive control: the second redirect response came from the HTTP cache');
        await page.goto(`${origin}/cache/neutral`);
        const { blocked } = await configure(e, [rule(1081, url)]);
        try { await page.goto(url); } catch (error) { if (!(await page.url()).startsWith(blocked)) throw error; }
        await until(() => page.url(), value => value.startsWith(blocked), `a cached ${status} cannot bypass a new rule`);
        await attach(e, `warm-${status}`, { coldHits: before,
          finalHits: server.requests.filter(request => request.path === `/cache/redirect/${status}`).length, finalUrl: await page.url() });
        await configure(e, []);
      }
    });
  }
}];
