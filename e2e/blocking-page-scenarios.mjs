import assert from 'node:assert/strict';
import { inBackground } from './scheduled-expiry-probes.mjs';

async function poll(read, check, label) {
  const deadline = Date.now() + 15000;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
async function navigate(page, url, accepts, label) {
  try { await page.goto(url); }
  catch (error) {
    // A DNR replacement can abort the original BiDi navigation. Never retry
    // it; the exact final destination below remains the required assertion.
    if (!/NS_BINDING_ABORTED|net::ERR_ABORTED/.test(error.message)) throw error;
  }
  await poll(() => page.url(), accepts, label);
}
const press = (page, key) => page.keyboard ? page.keyboard.press(key) : page.press(key);
const front = page => page.front ? page.front() : page.bringToFront();
const focusClose = async page => {
  await front(page);
  await page.evaluate(() => { document.activeElement?.blur(); });
  await press(page, 'Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'closeBtn', 'native Tab reaches Close');
};
const state = page => page.evaluate(() => ({
  main: document.querySelector('main')?.getAttribute('aria-labelledby'),
  title: document.title, lang: document.documentElement.lang, dir: document.documentElement.dir,
  reason: document.getElementById('blockedReason')?.textContent,
  status: document.getElementById('closeStatus')?.textContent,
  disabled: document.getElementById('closeBtn')?.getAttribute('aria-disabled'),
  active: document.activeElement?.id,
  live: document.getElementById('closeStatus')?.getAttribute('role')
}));
const attach = async (e, value) => {
  if (e.testInfo?.attach) await e.testInfo.attach('blocking-pages', { contentType: 'application/json', body: JSON.stringify(value) });
  else e.result.blockingPagesEvidence = value;
};

// Chrome also exposes browser.*. The harness identifies the target; a
// namespace's existence must not select the Firefox-only message path.
export function installClosePageProbe({ firefox }) {
  const api = firefox ? browser : chrome;
  const target = firefox ? api.runtime : api.tabs;
  const key = firefox ? 'sendMessage' : 'getCurrent';
  const original = target[key];
  const probe = { target, key, original, calls: 0 };
  target[key] = function(...args) {
    if (firefox && args[0]?.type !== 'close_current_tab') return original.apply(this, args);
    probe.calls += 1;
    return new Promise((resolve, reject) => { probe.reject = reject; });
  };
  window.__bdClosePageProbe = probe;
}

export const blockingPageScenarios = [{
  id: '64',
  title: 'Blocking screens localize their state, retain native keyboard focus through close failures and close only the intended tab',
  async run(e) {
    const rules = [
      { id: 640, blockURL: 'block-screen.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
        assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] },
      { id: 641, blockURL: 'redirect-screen.bd-e2e.test', redirectURL: 'http://redirect-target.bd-e2e.test/verified', category: 'social', isWhitelist: false,
        assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] }
    ];
    await e.seed({ pro: true, rules });
    const control = await e.openOptions();
    await e.reconcile(control); // Apply the seeded profile once, before observations.
    const info = await control.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const keys = ['blockedtitle', 'blockedbutton', 'blocking_mode_always', 'blockedclosepending', 'blockedclosefailed', 'redirecttitle', 'redirectpending'];
      return { base: api.runtime.getURL(''), lang: api.i18n.getMessage('@@ui_locale').replace(/_/g, '-'),
        dir: api.i18n.getMessage('@@bidi_dir'), messages: Object.fromEntries(keys.map(key => [key, api.i18n.getMessage(key)])) };
    });
    const before = await e.state();
    const blocked = await e.newPage();
    await navigate(blocked, 'http://block-screen.bd-e2e.test/native', url => url.startsWith(info.base + 'blocked.html'), 'real DNR blocking page');
    await poll(() => state(blocked), value => value.live === 'status' && value.reason === info.messages.blocking_mode_always, 'localized reason and close UI');
    assert.equal((await state(blocked)).main, 'blockedHeading');
    assert.equal((await state(blocked)).title, info.messages.blockedtitle);
    assert.equal((await state(blocked)).lang, info.lang); assert.equal((await state(blocked)).dir, info.dir);
    if (blocked.getByRole) assert.equal(await blocked.getByRole('button', { name: info.messages.blockedbutton, exact: true }).count(), 1);
    else assert.equal(await (await blocked.element('#closeBtn')).getAccessibleName(), info.messages.blockedbutton);
    const tabId = await control.evaluate(async base => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      return (await api.tabs.query({})).find(tab => tab.url?.startsWith(base + 'blocked.html'))?.id;
    }, info.base);
    assert.ok(Number.isInteger(tabId));

    // Only the API outcome is held/rejected. Input, focus, DOM and later real
    // closure remain native; this is a fault-injection UI check.
    await blocked.evaluate(installClosePageProbe, { firefox: !e.worker });
    await focusClose(blocked); await press(blocked, 'Enter');
    const pending = await poll(() => state(blocked), value => value.disabled === 'true', 'native pending close');
    assert.equal(pending.status, info.messages.blockedclosepending); assert.equal(pending.active, 'closeBtn');
    await press(blocked, 'Enter');
    assert.equal(await blocked.evaluate(() => __bdClosePageProbe.calls), 1, 'one request while pending');
    await blocked.evaluate(() => {
      const heading = document.getElementById('blockedHeading'); heading.tabIndex = -1; heading.focus();
      __bdClosePageProbe.reject(new Error('synthetic close rejection'));
    });
    const failure = await poll(() => state(blocked), value => value.status === info.messages.blockedclosefailed && value.disabled === 'false', 'safe persistent close error');
    assert.equal(failure.active, 'blockedHeading', 'later focus stays where the user chose');
    await blocked.evaluate(() => { const probe = __bdClosePageProbe; probe.target[probe.key] = probe.original; });
    await focusClose(blocked); await press(blocked, 'Space');
    await poll(() => control.evaluate(async id => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      return (await api.tabs.query({})).some(tab => tab.id === id);
    }, tabId), exists => !exists, 'explicit native retry closes its own tab');
    assert.ok(await control.evaluate(() => !!document.getElementById('add-rule')), 'control tab remains open');

    // Unmodified background + real DNR authorization: the configured target
    // must be reached before testing the controlled waiting UI separately.
    const allowed = await e.newPage();
    await navigate(allowed, 'http://redirect-screen.bd-e2e.test/native', url => url === 'http://redirect-target.bd-e2e.test/verified', 'real authorized redirect');

    const waiting = await e.newPage();
    await inBackground(e, (view, { namespace }) => {
      const api = view[namespace];
      const original = api.declarativeNetRequest.getDynamicRules;
      const probe = view.__bdRedirectPageProbe = { calls: 0, original };
      api.declarativeNetRequest.getDynamicRules = function(...args) {
        const nativeResult = original.apply(this, args);
        if (!new view.Error().stack.includes('redirectAuthorization.js')) return nativeResult;
        probe.calls += 1;
        return Promise.resolve(nativeResult).then(rules => new view.Promise(resolve => {
          probe.release = () => resolve(rules);
        }));
      };
    }, { namespace: e.worker ? 'chrome' : 'browser' });
    try {
      await waiting.goto(info.base + 'redirect.html?from=unverified.example&to=https%3A%2F%2Funtrusted.example');
      const loading = await poll(() => waiting.evaluate(() => ({ title: document.title, lang: document.documentElement.lang,
        dir: document.documentElement.dir, main: !!document.querySelector('main'), message: document.getElementById('redirectPending')?.textContent,
        decorative: document.querySelector('.loader')?.getAttribute('aria-hidden') })),
        value => value.title === info.messages.redirecttitle, 'localized waiting page');
      assert.equal(loading.message, info.messages.redirectpending); assert.equal(loading.lang, info.lang); assert.equal(loading.dir, info.dir);
      assert.equal(loading.decorative, 'true'); assert.equal(loading.main, true);
      assert.equal(await inBackground(e, view => view.__bdRedirectPageProbe.calls), 1);
      await inBackground(e, view => { view.__bdRedirectPageProbe.release(); });
      await poll(() => waiting.url(), url => url === info.base + 'blocked.html', 'denied redirect falls back to local blocking page');
      const after = await e.state();
      assert.deepEqual(after.rules, before.rules); assert.deepEqual(after.dnr, before.dnr);
      await attach(e, { pending, failure, loading, closedTabId: tabId,
        note: 'Installed extension, native DNR block/authorized redirect and native keyboard close. Close error is a controlled UI probe; waiting holds delivery of a native DNR read. No screen-reader speech or mobile claim.' });
    } finally {
      await inBackground(e, (view, { namespace }) => {
        const probe = view.__bdRedirectPageProbe;
        view[namespace].declarativeNetRequest.getDynamicRules = probe.original; probe.release?.();
        delete view.__bdRedirectPageProbe;
      }, { namespace: e.worker ? 'chrome' : 'browser' });
    }
  }
}];
