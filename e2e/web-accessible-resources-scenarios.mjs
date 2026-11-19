import assert from 'node:assert/strict';
import { dailyRule, basicPayload, equalEventually, poll } from './fixtures.mjs';

const publicPages = ['blocked.html', 'redirect.html'];
const privateFiles = ['styles/blocked.css', 'scripts/blocked.js', 'styles/redirect.css',
  'scripts/redirect.js', 'onboarding/onboarding.html', 'onboarding/onboarding.css',
  'onboarding/onboarding.js'];

async function fetchResources(page, urls) {
  return page.evaluate(async urls => {
    const results = {};
    for (const [path, url] of Object.entries(urls)) {
      try { results[path] = (await fetch(url)).ok; }
      catch { results[path] = false; }
    }
    return results;
  }, urls);
}

export const webAccessibleResourceScenarios = [{
  id: '92',
  title: 'websites cannot fetch private assets while permission setup, blocking and custom redirects work',
  async run(e) {
    const paths = [...publicPages, ...privateFiles];
    const urls = await e.probe.evaluate(paths => Object.fromEntries(
      paths.map(path => [path, browser.runtime.getURL(path)])), paths);
    const webUrl = 'http://war-probe.bd-e2e.test/';
    const web = await e.newPage(webUrl);
    const external = await fetchResources(web, urls);
    assert.deepEqual(external, Object.fromEntries(
      paths.map(path => [path, publicPages.includes(path)])), 'native website access');
    const internal = await fetchResources(e.probe, urls);
    assert.deepEqual(internal, Object.fromEntries(paths.map(path => [path, true])),
      'extension-owned pages retain every private dependency');

    // Exercise the private onboarding page and its real permission request in
    // this harness's disposable profile, including a native browser grant.
    await e.probe.evaluate(() => browser.permissions.remove({ origins: ['*://*/*'] }));
    await equalEventually(() => e.probe.evaluate(() =>
      browser.permissions.contains({ origins: ['*://*/*'] })), false, 'host access removed');
    await e.grantHostAccess();

    const daily = dailyRule(701); daily.assignments[0].dailyLimit.minutes = 1;
    const target = 'http://war-target.bd-e2e.test/destination?keep=a%26b&path=%2Fstudy#fragment%20kept';
    const { assignment, ...redirect } = basicPayload('war-source.bd-e2e.test');
    await e.seed({ rules: [daily, { id: 702, ...redirect, redirectURL: target,
      isWhitelist: false, assignments: [assignment] }], usage: { '701:general': 65 } });
    await e.reconcile(e.probe);
    const source = 'http://usage.bd-e2e.test/watch?keep=a%26b#original';
    const blocked = await e.assertBlocked(source, 'daily_limit');
    const blockedUrl = await blocked.url();
    assert.equal(new URL(blockedUrl).searchParams.get('url'), daily.blockURL, 'blocked page receives the saved rule target');
    await equalEventually(() => blocked.evaluate(() =>
      document.getElementById('blockedReason').getAttribute('data-i18n')),
    'daily_limit_reached', 'private blocked module executes');
    const styles = await blocked.evaluate(() => [...document.styleSheets].map(sheet =>
      ({ path: new URL(sheet.href).pathname, rules: sheet.cssRules.length })));
    assert.ok(styles.some(sheet => sheet.path === '/styles/blocked.css' && sheet.rules > 0),
      'private blocked stylesheet applies');
    const tabId = await blocked.evaluate(async () => (await browser.tabs.getCurrent()).id);
    await blocked.click('#closeBtn');
    await poll(() => e.probe.evaluate(async id => {
      try { await browser.tabs.get(id); return false; } catch { return true; }
    }, tabId), Boolean, 'private blocked module closes its own tab');

    const redirected = await e.newPage('http://war-source.bd-e2e.test/first?source=yes#origin');
    await equalEventually(() => redirected.url(), target, 'native custom redirect preserves query and fragment');
    // Firefox reports intentional WAR denials as JavaScript security errors.
    // Accept only these exact requests; all other errors still fail the runner.
    const expectedDenials = new Set(privateFiles.map(path =>
      `Security Error: Content at ${webUrl} may not load or link to ${urls[path]}.`));
    const deniedRequestErrors = e.pageErrors.filter(message => expectedDenials.has(message));
    for (let i = e.pageErrors.length - 1; i >= 0; i--) {
      if (expectedDenials.has(e.pageErrors[i])) e.pageErrors.splice(i, 1);
    }
    e.result.warPrivacy = { external, internal, blockedUrl, styles, target,
      redirectUrl: await redirected.url(), onboardingPermissionGranted: true, deniedRequestErrors };
  }
}];
