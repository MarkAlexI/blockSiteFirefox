import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
import { CategoryManager, CATEGORIES } from '../rules/categoryManager.js';
import { normalizeDomainRule } from '../rules/normalizeDomainRule.js';
import { normalizePathRule } from '../rules/normalizePathRule.js';
import { normalizePathSegment } from '../rules/normalizePathSegment.js';
import { isValidPathSegment } from '../scripts/isValidPathSegment.js';
import {
  hasUnsupportedExplicitScheme,
  isBlockedURL
} from '../scripts/isBlockedURL.js';
import { isUrlInWhitelist } from '../pro/isUrlInWhitelist.js';
import { resolveContextTarget } from '../utils/resolveContextTarget.js';
import { createInstallURL } from '../utils/createInstallURL.js';
import { updateUninstallURL } from '../utils/updateUninstallURL.js';
import { shouldSkipSync } from '../utils/shouldSkipSync.js';
import { getTelemetryExtensionVersion } from '../utils/buildInfo.js';
import { getCurrentTabs } from '../scripts/getCurrentTabs.js';
import { customAlert } from '../scripts/customAlert.js';
import { scrollToTop, mountScroll } from '../dom/scrollToTop.js';
import { initializeNoSpaceInputs } from '../utils/noSpaces.js';
import { checkDNR } from '../utils/dnrDebug.js';
import { IS_FIREFOX, MAX_RULES_LIMIT } from '../utils/constants.js';

const always = (listId = 'general', disabledByUser = false) => ({
  listId,
  disabledByUser,
  blockingMode: 'always',
  schedule: null,
  dailyLimit: null
});

test('the Free plan limit remains exactly ten rules', () => {
  assert.equal(MAX_RULES_LIMIT, 10);
});

test('domain normalization removes www, lowercases hostnames, and preserves invalid input', () => {
  assert.equal(normalizeDomainRule('https://WWW.Example.COM:8443/path?q=yes'), 'example.com');
  assert.equal(normalizeDomainRule('https://m.example.com/path'), 'm.example.com');
  assert.equal(normalizeDomainRule('not a valid URL'), 'not a valid URL');
});

test('path normalization supports pasted domains, strips trailing slashes, and rejects malformed encoding', () => {
  assert.equal(normalizePathRule('https://www.Example.com/team/project///?draft=1'), 'example.com/team/project');
  assert.equal(normalizePathRule('HTTPS://WWW.Example.com/Team/'), 'example.com/Team');
  assert.equal(normalizePathRule('example.com/team%20space'), 'example.com/team%20space');
  assert.equal(normalizePathRule('%E0%A4%A'), '%E0%A4%A');
});

test('explicit non-web schemes are rejected while flexible web targets remain available', () => {
  for (const url of [
    'file:///tmp/page.html',
    'data:text/html,<h1>test</h1>',
    'ftp://example.com/file',
    'ws://example.com/socket',
    'about:config',
    'chrome://settings/',
    'edge://settings/',
    'moz-extension://extension-id/options.html',
    'blob:https://example.com/id',
    'javascript:alert(1)'
  ]) {
    assert.equal(hasUnsupportedExplicitScheme(url), true, url);
    assert.equal(isBlockedURL([{ url }]), true, url);
  }

  for (const url of [
    'https://example.com/path',
    'HTTPS://Example.com/path',
    'example.com/path',
    'example.com:8080/path',
    'localhost:3000',
    'intranet:8080/path',
    'tube'
  ]) {
    assert.equal(hasUnsupportedExplicitScheme(url), false, url);
    assert.equal(isBlockedURL([{ url }]), false, url);
  }
});

test('path segment validation rejects broken UTF-16 while encoding supported characters', () => {
  assert.equal(normalizePathSegment('team / Київ'), 'team%20%2F%20%D0%9A%D0%B8%D1%97%D0%B2');
  assert.equal(isValidPathSegment('Київ/example'), true);
  assert.equal(isValidPathSegment('\uD800'), false);
});

test('category manager exposes the configured categories without replacing their shared list', () => {
  assert.equal(CategoryManager.getCategories(), CATEGORIES);
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length);
  assert.equal(CATEGORIES.includes('uncategorized'), true);
});

test('context targets prioritize explicit links over page and tab URLs', () => {
  assert.deepEqual(resolveContextTarget({
    linkUrl: 'https://linked.example/path',
    pageUrl: 'https://page.example/'
  }, { url: 'https://tab.example/' }), {
    type: 'link',
    url: 'https://linked.example/path'
  });
});

test('context targets fall back from an empty link to the explicit page and then the tab', () => {
  assert.deepEqual(resolveContextTarget({ linkUrl: '', pageUrl: 'https://page.example/' }, {
    url: 'https://tab.example/'
  }), { type: 'page', url: 'https://page.example/' });
  assert.deepEqual(resolveContextTarget({}, { url: 'https://tab.example/' }), {
    type: 'page',
    url: 'https://tab.example/'
  });
  assert.equal(resolveContextTarget({ linkUrl: null, pageUrl: '' }, {}), null);
});

test('whitelist matching accepts exact domains, subdomains, paths, and case differences', () => {
  const rules = [{ blockURL: 'Example.COM/team', assignments: [always()] }];
  assert.equal(isUrlInWhitelist('https://example.com/TEAM?view=1', rules), true);
  assert.equal(isUrlInWhitelist('https://sub.allowed.example/', [{
    blockURL: 'ALLOWED.EXAMPLE', assignments: [always()]
  }]), true);
  assert.equal(isUrlInWhitelist('https://allowed.example/', [{
    blockURL: 'allowed.example', assignments: [always()]
  }]), true);
});

test('whitelist matching ignores disabled, empty, malformed, and unrelated rules', () => {
  assert.equal(isUrlInWhitelist('https://allowed.example/', [{
    blockURL: 'allowed.example', assignments: [always('general', true)]
  }]), false);
  assert.equal(isUrlInWhitelist('https://allowed.example/', [{ blockURL: ' ', assignments: [always()] }]), false);
  assert.equal(isUrlInWhitelist('not a URL', [{ blockURL: 'allowed.example', assignments: [always()] }]), false);
  assert.equal(isUrlInWhitelist('', []), false);
  assert.equal(isUrlInWhitelist('https://another.example/', null), false);
});

test('whitelist domains never match lookalike hosts, credentials, paths, or query strings', () => {
  const rules = [{ blockURL: 'allowed.example', assignments: [always()] }];

  for (const url of [
    'https://notallowed.example/',
    'https://allowed.example.evil.test/',
    'https://allowed.example@evil.test/',
    'https://evil.test/allowed.example',
    'https://evil.test/?next=allowed.example',
    'https://evil.test/#allowed.example'
  ]) {
    assert.equal(isUrlInWhitelist(url, rules), false, url);
  }
});

test('whitelist paths match only the requested path or its descendants', () => {
  const rules = [{ blockURL: 'https://WWW.Allowed.Example/team/', assignments: [always()] }];

  assert.equal(isUrlInWhitelist('https://allowed.example/TEAM', rules), true);
  assert.equal(isUrlInWhitelist('https://sub.allowed.example/team/project', rules), true);
  assert.equal(isUrlInWhitelist('https://allowed.example/teamwork', rules), false);
  assert.equal(isUrlInWhitelist('https://allowed.example/other?next=/team', rules), false);
});

test('short whitelist patterns remain flexible within hostnames without inspecting URL text', () => {
  const rules = [{ blockURL: 'tube', assignments: [always()] }];

  assert.equal(isUrlInWhitelist('https://youtube.com/watch', rules), true);
  assert.equal(isUrlInWhitelist('https://evil.example/watch/tube', rules), false);
  assert.equal(isUrlInWhitelist('https://evil.example/?next=youtube.com', rules), false);
});

test('protected project and store URLs cannot be spoofed through another site', () => {
  const storeUrl = IS_FIREFOX
    ? 'https://addons.mozilla.org/firefox/addon/blockersite/'
    : 'https://chromewebstore.google.com/detail/example';
  const fakeStoreUrl = IS_FIREFOX
    ? 'https://addons.mozilla.org.evil.example/firefox/'
    : 'https://chromewebstore.google.com.evil.example/detail/example';

  for (const url of [
    'https://blockdistraction.com/account.html',
    'https://support.blockdistraction.com/',
    'https://markdigital.cc/',
    'https://service.ext.pp.ua/',
    storeUrl
  ]) {
    assert.equal(isBlockedURL([{ url }]), true, url);
  }

  for (const url of [
    'https://evil.example/?next=blockdistraction.com',
    'https://evil.example/markdigital/account',
    'https://evil.example/#ext.pp.ua',
    'https://notblockdistraction.com/',
    'https://blockdistraction.com.evil.example/',
    'https://markdigital.com/',
    'https://support.markdigital.com/',
    fakeStoreUrl
  ]) {
    assert.equal(isBlockedURL([{ url }]), false, url);
  }

  assert.equal(isBlockedURL([{ url: 'blockdistraction' }]), true);
  assert.equal(isBlockedURL([{ url: 'markdigital.cc' }]), true);
  assert.equal(isBlockedURL([{ url: 'markdigital' }]), false);
});

test('installation URL always opens the packaged Options page', async () => {
  const api = createExtensionApi();
  await withExtensionEnvironment(api, () => {
    assert.equal(createInstallURL(), 'extension://test-extension-id/options/options.html');
  });
});

test('uninstall context includes only coarse state and never includes the license key or email', async () => {
  const api = createExtensionApi({
    sync: { credentials: {
      isLegacyUser: true,
      installationDate: '2026-08-01T00:00:00.000Z',
      isPro: true,
      licenseKey: 'BD-PRO-SECRET',
      subscriptionEmail: 'secret@example.com'
    } },
    local: { rules: [{ id: 1 }, { id: 2 }] },
    version: '5.1.7'
  });

  await withExtensionEnvironment(api, async () => {
    await updateUninstallURL();
    const url = new URL(api.uninstallUrls[0]);
    const context = JSON.parse(Buffer.from(url.searchParams.get('ctx'), 'base64').toString('utf8'));
    assert.equal(url.origin + url.pathname, 'https://blockdistraction.com/uninstall.html');
    assert.deepEqual(context, {
      l: true,
      d: '2026-08-01T00:00:00.000Z',
      p: true,
      v: '5.1.7',
      r: 2
    });
    assert.equal(JSON.stringify(context).includes('BD-PRO-SECRET'), false);
    assert.equal(JSON.stringify(context).includes('secret@example.com'), false);
  });
});

test('uninstall context handles missing credentials and rules without inventing values', async () => {
  const api = createExtensionApi();
  await withExtensionEnvironment(api, async () => {
    await updateUninstallURL();
    const context = JSON.parse(Buffer.from(
      new URL(api.uninstallUrls[0]).searchParams.get('ctx'), 'base64'
    ).toString('utf8'));
    assert.deepEqual(context, { l: null, d: null, p: null, v: '5.1.7', r: null });
  });
});

test('license sync skips only checks performed less than twelve hours ago', async () => {
  const now = 1_800_000_000_000;
  const previousNow = Date.now;
  Date.now = () => now;

  try {
    for (const [lastCheck, expected] of [
      [undefined, false],
      [now - 12 * 60 * 60 * 1000 + 1, true],
      [now - 12 * 60 * 60 * 1000, false]
    ]) {
      const api = createExtensionApi({ local: { lastCheck } });
      await withExtensionEnvironment(api, async () => {
        assert.equal(await shouldSkipSync(), expected);
      });
    }
  } finally {
    Date.now = previousNow;
  }
});

test('focus sessions return defaults for missing, expired, and inaccessible storage', async () => {
  const api = createExtensionApi();
  await withExtensionEnvironment(api, async () => {
    const { getFocusSessionState } = await import('../utils/focusSession.js');
    assert.deepEqual(await getFocusSessionState(), {
      focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist'
    });

    api.storage.local.data.focusSession = {
      focusActive: true, focusEndTime: Date.now() - 1, isHardcore: true, focusMode: 'whitelist'
    };
    assert.equal((await getFocusSessionState()).focusActive, false);

    api.storage.local.data.focusSession.focusEndTime = Date.now() + 60_000;
    assert.equal((await getFocusSessionState()).focusMode, 'whitelist');

    const previousError = console.error;
    console.error = () => {};
    api.storage.local.getError = new Error('storage unavailable');
    try {
      assert.equal((await getFocusSessionState()).focusActive, false);
    } finally {
      console.error = previousError;
    }
  });
});

test('telemetry versions preserve release candidates and handle absent manifest values', () => {
  assert.equal(getTelemetryExtensionVersion({ version: ' 5.1.7 ' }, 'RC12'), '5.1.7-rc12');
  assert.equal(getTelemetryExtensionVersion({ version: '5.1.7' }, 'nightly'), '5.1.7');
  assert.equal(getTelemetryExtensionVersion({ version: '' }, 'RC1'), 'unknown');
  assert.equal(getTelemetryExtensionVersion(null, null), 'unknown');
});

test('current tab lookup uses the active current window and tolerates an empty callback', async () => {
  const api = createExtensionApi({ tabs: [{ id: 7, url: 'https://active.example/' }] });
  await withExtensionEnvironment(api, async () => {
    assert.deepEqual(await getCurrentTabs(), [{ id: 7, url: 'https://active.example/' }]);
    api.tabs.query = (_query, callback) => callback(undefined);
    assert.deepEqual(await getCurrentTabs(), []);
  });
});

test('scroll controls smoothly return to the top and track intersection visibility', async () => {
  const document = new FakeDocument();
  const button = document.addElement('scrollButton', 'button');
  const target = document.addElement('target');
  const observed = [];
  let intersectionCallback;
  let scrollOptions;
  document.documentElement.scrollTo = options => { scrollOptions = options; };
  const previousObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback, options) {
      intersectionCallback = callback;
      this.options = options;
    }
    observe(element) { observed.push(element); }
  };

  try {
    await withExtensionEnvironment(createExtensionApi(), () => {
      scrollToTop();
      mountScroll(target, button);
      assert.deepEqual(scrollOptions, { top: 0, behavior: 'smooth' });
      assert.deepEqual(observed, [target]);
      intersectionCallback([{ isIntersecting: false }]);
      assert.equal(button.classList.contains('showBtn'), true);
      intersectionCallback([{ isIntersecting: true }]);
      assert.equal(button.classList.contains('showBtn'), false);
    }, { document, window: { document } });
  } finally {
    if (previousObserver) globalThis.IntersectionObserver = previousObserver;
    else delete globalThis.IntersectionObserver;
  }
});

test('focus session reads reject malformed or boundary-expired active state', async () => {
  const now = Date.now();
  const api = createExtensionApi();
  await withExtensionEnvironment(api, async () => {
    const { getFocusSessionState } = await import('../utils/focusSession.js');

    for (const focusSession of [
      { focusActive: true, focusEndTime: now },
      { focusActive: true, focusEndTime: 0 },
      { focusActive: true, focusEndTime: 'not-a-time', isHardcore: true, focusMode: 'whitelist' },
      { focusActive: 'true', focusEndTime: now + 60_000, isHardcore: true, focusMode: 'whitelist' }
    ]) {
      api.storage.local.data.focusSession = focusSession;
      assert.deepEqual(await getFocusSessionState(), {
        focusActive: false,
        focusEndTime: 0,
        isHardcore: false,
        focusMode: 'blacklist'
      });
    }
  });
});

test('focus session reads normalize a valid future record to its supported contract', async () => {
  const endTime = Date.now() + 60_000;
  const api = createExtensionApi({ local: {
    focusSession: {
      focusActive: true,
      focusEndTime: String(endTime),
      isHardcore: 1,
      focusMode: 'unsupported'
    }
  } });

  await withExtensionEnvironment(api, async () => {
    const { getFocusSessionState } = await import('../utils/focusSession.js');
    assert.deepEqual(await getFocusSessionState(), {
      focusActive: true,
      focusEndTime: endTime,
      isHardcore: false,
      focusMode: 'blacklist'
    });
  });
});

test('space filtering handles existing inputs, newly inserted inputs, and nested inputs', async () => {
  const document = new FakeDocument();
  const container = document.addElement('rules-container');
  const existing = document.createElement('input');
  existing.type = 'text';
  existing.value = ' first\t value ';
  container.appendChild(existing);
  let mutationCallback;
  let observedOptions;
  const previousMutationObserver = globalThis.MutationObserver;
  const previousNode = globalThis.Node;
  globalThis.Node = { ELEMENT_NODE: 1 };
  globalThis.MutationObserver = class {
    constructor(callback) { mutationCallback = callback; }
    observe(target, options) { observedOptions = { target, options }; }
  };

  try {
    await withExtensionEnvironment(createExtensionApi(), async () => {
      initializeNoSpaceInputs();
      await existing.dispatch('input');
      assert.equal(existing.value, 'firstvalue');

      const inserted = document.createElement('input');
      inserted.type = 'text';
      inserted.value = ' new value ';
      const wrapper = document.createElement('section');
      const nested = document.createElement('input');
      nested.type = 'text';
      nested.value = ' nested value ';
      wrapper.appendChild(nested);
      mutationCallback([{ addedNodes: [inserted, wrapper, document.createTextNode('ignore')] }]);
      await inserted.dispatch('input');
      await nested.dispatch('input');
      assert.equal(inserted.value, 'newvalue');
      assert.equal(nested.value, 'nestedvalue');
      assert.deepEqual(observedOptions, { target: container, options: { childList: true, subtree: true } });
    }, { document });
  } finally {
    if (previousMutationObserver) globalThis.MutationObserver = previousMutationObserver;
    else delete globalThis.MutationObserver;
    if (previousNode) globalThis.Node = previousNode;
    else delete globalThis.Node;
  }
});

test('custom alerts display the message, fade out, and remove their temporary node', async () => {
  const document = new FakeDocument();
  const scheduled = [];
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };

  try {
    await withExtensionEnvironment(createExtensionApi(), () => {
      customAlert('Rule saved');
      const alertElement = document.body.children[0];
      assert.equal(alertElement.textContent, 'Rule saved');
      assert.equal(scheduled[0].delay, 3000);
      scheduled[0].callback();
      assert.equal(alertElement.style.opacity, '0');
      assert.equal(scheduled[1].delay, 500);
      scheduled[1].callback();
      assert.equal(document.body.children.length, 0);
    }, { document });
  } finally {
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('DNR inspection reports empty rules, readable rules, and API failures', async () => {
  const api = createExtensionApi();
  const logged = [];
  const tables = [];
  const errors = [];
  const previousLog = console.log;
  const previousTable = console.table;
  const previousError = console.error;
  console.log = (...values) => logged.push(values);
  console.table = value => tables.push(value);
  console.error = (...values) => errors.push(values);
  api.declarativeNetRequest = { async getDynamicRules() { return []; } };

  try {
    await withExtensionEnvironment(api, async () => {
      await checkDNR();
      assert.match(logged[0][0], /No active rules/);
      api.declarativeNetRequest.getDynamicRules = async () => [{
        id: 9,
        priority: 1,
        condition: { urlFilter: 'example.com' },
        action: { type: 'redirect', redirect: { url: 'https://safe.example/' } }
      }];
      await checkDNR();
      assert.deepEqual(tables[0], [{
        ID: 9,
        Priority: 1,
        Filter: 'example.com',
        Action: 'redirect',
        RedirectTo: 'https://safe.example/'
      }]);
      api.declarativeNetRequest.getDynamicRules = async () => { throw new Error('DNR unavailable'); };
      await checkDNR();
      assert.match(errors[0][0], /Failed to fetch rules/);
    });
  } finally {
    console.log = previousLog;
    console.table = previousTable;
    console.error = previousError;
  }
});
