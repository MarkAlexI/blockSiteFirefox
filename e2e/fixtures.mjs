import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { By, Key, Select, error as webdriverError } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { zipSync, unzipSync } from 'fflate';
import { expectedVersion } from './target-version.mjs';
import { selectLiveWindow } from './window-selection.mjs';
import { createFixtureProxy } from './fixture-proxy.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoots = ['_locales', 'backup', 'blocked.html', 'diagnostics', 'dom', 'feedback', 'images',
  'index.html', 'manifest.json', 'onboarding', 'options', 'popup.js', 'pro', 'redirect.html', 'rules',
  'schedules', 'scripts', 'styles', 'telemetry', 'update', 'utils'];
const VERIFY_URL = 'https://blockdistraction.com/api/verifyKey';
const HTML = '<!doctype html><html><head><title>BD E2E fixture</title></head><body><h1>BD E2E fixture</h1><p>Local synthetic page.</p></body></html>';
export const TEST_KEY = 'BD-E2E-VALID-KEY';
export const SITE = 'http://usage.bd-e2e.test';
export const LISTS = [
  { id: 'general', name: 'General', disabledCategories: [] },
  { id: 'list-1', name: 'Study', disabledCategories: [] },
  { id: 'list-2', name: 'Work', disabledCategories: [] }
];
export const assignment = (listId = 'general', minutes = 10) => ({
  listId, disabledByUser: false, blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes }
});
export const dailyRule = (id = 21, listId = 'general') => ({
  id, blockURL: 'usage.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
  assignments: [assignment(listId)]
});
export const basicPayload = blockURL => ({ blockURL, redirectURL: '', category: 'social',
  assignment: { listId: 'general', blockingMode: 'always', schedule: null, dailyLimit: null } });
export const paidPayload = blockURL => ({ ...basicPayload(blockURL), assignment: assignment() });
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class EnvironmentError extends Error {}

export async function poll(read, check, label, timeout = 15_000) {
  const start = Date.now();
  let value;
  while (Date.now() - start < timeout) {
    value = await read();
    if (check(value)) return value;
    await delay(250);
  }
  assert.fail(`${label}: timed out; last value=${JSON.stringify(value)}`);
}
export const equalEventually = (read, expected, label, timeout) => poll(read,
  value => { try { assert.deepEqual(value, expected); return true; } catch { return false; } }, label, timeout);

// Native BiDi calls do not switch the foreground tab. Concurrent callers use
// independent page contexts; no shared WebDriver switchTo() race is involved.
class Page {
  constructor(harness, context) { this.harness = harness; this.context = context; }
  async evaluate(fn, input = null) {
    const expression = `(async () => JSON.stringify(await (${fn.toString()})(${JSON.stringify(input)})))()`;
    const reply = await this.harness.command('script.evaluate', {
      expression, target: { context: this.context }, awaitPromise: true
    });
    if (reply.type === 'exception') throw new Error(reply.exceptionDetails.text);
    if (reply.result.type === 'undefined') return null;
    assert.equal(reply.result.type, 'string', 'BiDi result must be serialized JSON');
    return JSON.parse(reply.result.value);
  }
  async goto(url) {
    await this.harness.command('browsingContext.navigate', { context: this.context, url, wait: 'complete' });
  }
  async url() { return this.evaluate(() => location.href); }
  async front() {
    // Firefox BiDi refuses activation of moz-extension: privileged contexts.
    // Classic WebDriver selects the real tab, including extension pages.
    if (await selectLiveWindow(this.harness.driver, this.context, webdriverError.NoSuchWindowError)) {
      // visibilitychange starts an asynchronous Options refresh. Do not click
      // an old row while that refresh is replacing the table.
      await this.settleOptions();
    }
  }
  async settleOptions() {
    await poll(() => this.evaluate(() => {
      const roots = [...document.querySelectorAll('#rules-container, #rule-lists-container')];
      if (!roots.length) return true;
      if (!window.__bdE2eViewObserver) {
        const view = { lastMutation: performance.now() };
        view.observer = new MutationObserver(() => { view.lastMutation = performance.now(); });
        for (const root of roots) view.observer.observe(root, {
          childList: true, subtree: true, attributes: true, characterData: true
        });
        window.__bdE2eViewObserver = view;
      }
      return performance.now() - window.__bdE2eViewObserver.lastMutation >= 500;
    }), Boolean, 'Options table settled');
  }
  async elements(css) {
    await this.front();
    return this.harness.driver.findElements(By.css(css));
  }
  async element(css) {
    return poll(async () => (await this.elements(css))[0], Boolean, `element ${css}`);
  }
  async click(css) {
    await this.front();
    for (let attempt = 1; ; attempt++) {
      try { await (await this.element(css)).click(); return; }
      catch (error) {
        // A stale-element rejection means no click was dispatched. Reacquire
        // only that case; never repeat a successful action or a failed test.
        if (!(error instanceof webdriverError.StaleElementReferenceError) || attempt >= 3) throw error;
        this.harness.result.uiRetries ??= [];
        this.harness.result.uiRetries.push({ selector: css, attempt, reason: 'stale_element' });
        await this.settleOptions();
      }
    }
  }
  async fill(css, value) {
    const element = await this.element(css);
    await element.clear();
    await element.sendKeys(String(value));
  }
  async select(css, value) { await new Select(await this.element(css)).selectByValue(value); }
  async count(css) { return this.evaluate(css => document.querySelectorAll(css).length, css); }
  async text(css) { return this.evaluate(css => document.querySelector(css)?.textContent ?? null, css); }
  async enabled(css, expected = true) {
    await equalEventually(() => this.evaluate(css => {
      const node = document.querySelector(css);
      return node ? !node.disabled : null;
    }, css), expected, `${css} enabled=${expected}`);
  }
  async hasClass(css, value) {
    await poll(() => this.evaluate(css => document.querySelector(css)?.className, css),
      actual => typeof actual === 'string' && actual.includes(value), `${css} class ${value}`);
  }
}

export const send = (page, type, payload = {}) => page.evaluate(
  message => browser.runtime.sendMessage(message), { type, payload });

export async function addUi(page, blockURL, { dailyMinutes = null } = {}) {
  await page.click('#add-rule');
  const row = '#rules-container tr:has(.save-btn)';
  await equalEventually(() => page.count(row), 1, 'single editing row');
  await page.fill(`${row} td:nth-child(1) input`, blockURL);
  if (dailyMinutes !== null) {
    await page.select(`${row} .blocking-mode-select`, 'daily_limit');
    await page.fill(`${row} .daily-limit-minutes`, dailyMinutes);
  }
  await page.click(`${row} .save-btn`);
  await poll(() => page.text('#rules-container'), text => text?.includes(blockURL), 'saved rule visible');
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function collectRuntime(root) {
  const files = {};
  async function collect(relative) {
    const absolute = path.join(root, relative);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (entries) for (const entry of entries) await collect(`${relative}/${entry.name}`);
    else files[relative] = new Uint8Array(await readFile(absolute));
  }
  for (const rootName of runtimeRoots) await collect(rootName);
  return files;
}

export class ExtensionHarness {
  constructor(config, result) {
    this.config = config;
    this.result = result;
    this.driver = null;
    this.options = [];
    this.pageErrors = [];
    this.networkErrors = [];
    this.events = [];
    this.verificationCalls = [];
    this.verificationHandler = async () => ({ status: 200, body: { isPro: true } });
    this.phase = 'prepare';
  }

  async prepare() {
    this.root = await mkdtemp(path.join(tmpdir(), 'bd-firefox-e2e-'));
    this.profile = path.join(this.root, 'profile');
    await mkdir(this.profile);
    await mkdir(this.config.output, { recursive: true });
    const source = path.resolve(process.env.BD_EXTENSION_PATH || path.join(directory, '..'));
    const files = process.env.BD_SIGNED_XPI ? unzipSync(new Uint8Array(await readFile(process.env.BD_SIGNED_XPI))) :
      await collectRuntime(source);
    this.manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
    assert.equal(this.manifest.version, expectedVersion, 'target version');
    assert.deepEqual(this.manifest.background, {
      scripts: ['scripts/service_worker.js'], persistent: false, type: 'module'
    }, 'Firefox event page manifest');
    this.id = this.manifest.browser_specific_settings.gecko.id;
    this.uuid = randomUUID();
    this.baseUrl = `moz-extension://${this.uuid}`;
    this.xpi = path.join(this.root, 'target.xpi');
    await writeFile(this.xpi, process.env.BD_SIGNED_XPI ? await readFile(process.env.BD_SIGNED_XPI) : zipSync(files));
    this.result.target = { version: this.manifest.version, id: this.id,
      installation: this.config.installation, signedInput: Boolean(process.env.BD_SIGNED_XPI) };
    this.proxy = await createFixtureProxy({ root: this.root, html: HTML, verifyUrl: VERIFY_URL,
      expectedPayload: { key: TEST_KEY, version: this.manifest.version },
      verificationHandler: () => this.verificationHandler(),
      onVerification: call => this.verificationCalls.push(call),
      onEvent: event => this.events.push(event), onError: error => this.networkErrors.push(error.stack),
      onTlsError: error => { this.result.fixtureTlsErrors ??= []; this.result.fixtureTlsErrors.push(error); } });
  }

  async command(method, params = {}) {
    const reply = await this.bidi.send({ method, params });
    if (reply.error) throw new Error(`${method}: ${reply.error}: ${reply.message}`);
    return reply.result;
  }

  async launch({ restarted = false } = {}) {
    this.phase = 'browser-launch';
    const marionettePort = await freePort();
    const options = new firefox.Options().enableBidi().addArguments('--profile', this.profile);
    if (this.config.headless) options.addArguments('-headless');
    if (process.env.BD_FIREFOX_BINARY) options.setBinary(process.env.BD_FIREFOX_BINARY);
    options.set('unhandledPromptBehavior', 'accept');
    options.setAcceptInsecureCerts(false);
    options.setPreference('intl.accept_languages', 'en-US,en');
    options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [this.id]: this.uuid }));
    const port = this.proxy.port;
    options.setPreference('network.proxy.type', 1);
    options.setPreference('network.proxy.http', '127.0.0.1').setPreference('network.proxy.http_port', port);
    options.setPreference('network.proxy.ssl', '127.0.0.1').setPreference('network.proxy.ssl_port', port);
    options.setPreference('network.proxy.no_proxies_on', '');
    // Documented extension-development mode, only in a newly created profile.
    // Release Firefox needs BD_SIGNED_XPI for a persistent installation.
    if (this.config.installation === 'persistent' && !process.env.BD_SIGNED_XPI) {
      options.setPreference('xpinstall.signatures.required', false);
    }
    const service = new firefox.ServiceBuilder(process.env.BD_GECKODRIVER || undefined)
      .setHostname('127.0.0.1')
      .addArguments('--host', '127.0.0.1', '--marionette-port', String(marionettePort), '--allow-system-access');
    const log = await open(path.join(this.config.output, restarted ? 'geckodriver-restart.log' : 'geckodriver.log'), 'w');
    service.setStdio(['ignore', log.fd, log.fd]);
    this.service = service.build();
    this.sessionReady = false;
    try {
      this.driver = await firefox.Driver.createSession(options, this.service);
      const capabilities = await this.driver.getCapabilities();
      this.sessionReady = true;
      this.result.browser = Object.fromEntries([...capabilities.keys()].map(key => [key, capabilities.get(key)]));
    } catch (error) {
      if (!this.sessionReady) this.driver = null;
      throw error;
    } finally { await log.close(); }
    this.phase = 'fixture-certificate';
    assert.equal((await this.driver.getCapabilities()).get('acceptInsecureCerts'), false);
    await this.driver.setContext(firefox.Context.CHROME);
    try {
      const trusted = await this.driver.executeScript(base64 => {
        const interfaces = Components.interfaces;
        const db = Components.classes['@mozilla.org/security/x509certdb;1']
          .getService(interfaces.nsIX509CertDB);
        const cert = db.addCertFromBase64(base64, 'C,,');
        return db.isCertTrusted(cert, interfaces.nsIX509Cert.CA_CERT,
          interfaces.nsIX509CertDB.TRUSTED_SSL);
      }, this.proxy.ca.replace(/-----[^-]+-----|\s/g, ''));
      assert.equal(trusted, true, 'loopback fixture CA trusted in the disposable profile');
      this.result.networkFixture = { transport: 'loopback HTTP + HTTPS CONNECT',
        certificateValidation: true, profileCaTrusted: trusted };
    } finally { await this.driver.setContext(firefox.Context.CONTENT); }
    this.phase = 'network-setup';
    this.bidi = await this.driver.getBidi();
    this.bidi.on('log.entryAdded', event => {
      if (event.type === 'javascript' && event.level === 'error') this.pageErrors.push(event.text);
    });
    this.bidi.on('browsingContext.userPromptOpened', event => {
      // unhandledPromptBehavior='accept' is handled natively by Firefox's
      // UserPromptHandlerManager. BiDi handleUserPrompt rejects extension
      // contexts and also races that automatic handler; observe it only.
      this.result.userPrompts ??= [];
      this.result.userPrompts.push({ context: event.context, type: event.type,
        handler: event.handler, message: event.message });
    });
    await this.command('session.subscribe', { events: [
      'log.entryAdded', 'browsingContext.userPromptOpened'
    ] });
    this.phase = 'addon-install';
    if (!restarted || this.config.installation === 'temporary') {
      const id = await this.driver.installAddon(this.xpi, this.config.installation === 'temporary');
      assert.equal(id, this.id);
    }
    // Opening a packaged popup gives access to real browser.* APIs. It is kept
    // in a background tab for storage reads; accounting polls never focus it.
    this.probe = await this.newPage(`${this.baseUrl}/index.html`);
    assert.equal(await this.probe.evaluate(() => browser.runtime.id), this.id);
    this.phase = 'extension-startup';
    await equalEventually(() => this.probe.evaluate(async () =>
      (await browser.storage.local.get('is_migrated_to_local')).is_migrated_to_local), true, 'startup migration', 20_000);
    const handles = await this.driver.getAllWindowHandles();
    for (const handle of handles) {
      if (handle === this.probe.context) continue;
      await this.driver.switchTo().window(handle);
      await this.driver.close();
    }
    await this.driver.switchTo().window(this.probe.context);
    this.phase = 'seed';
  }

  async newPage(url = 'about:blank') {
    const { context } = await this.command('browsingContext.create', { type: 'tab', background: true });
    const page = new Page(this, context);
    await page.goto(url);
    return page;
  }

  async seed({ pro = true, legacy = false, rules = [], usage = {}, active = 'general', pending = [], rawUsage = null, retainedKey = false, focus = null } = {}) {
    await this.probe.evaluate(async input => {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      await browser.storage.sync.set({ credentials: { isPro: input.pro, licenseKey: (input.pro || input.retainedKey) ? input.key : null,
        expiryDate: null, installationDate: input.legacy ? '2024-01-01T00:00:00.000Z' : '2026-08-01T00:00:00.000Z',
        isLegacyUser: input.legacy }, settings: { mode: 'normal', enablePassword: false, debugMode: false, focusSessionSound: false } });
      await browser.storage.local.set({ is_migrated_to_local: true, rules: input.rules, ruleLists: input.lists,
        activeRuleListId: input.active, pendingDailyUsageRemaps: input.pending,
        dailyRuleUsage: input.rawUsage ? { ...input.rawUsage, date } : { version: 2, date, usageSeconds: input.usage, lastSample: null },
        focusSession: input.focus || { focusActive: false, focusEndTime: 0, isHardcore: false, focusMode: 'blacklist' },
        telemetryConsent: { version: 1, enabled: false, decidedAt: now.getTime() }, lastCheck: now.getTime() });
    }, { pro, legacy, rules, usage, active, pending, rawUsage, retainedKey, focus, key: TEST_KEY, lists: LISTS });
  }

  async state() {
    return this.probe.evaluate(async () => ({
      ...await browser.storage.local.get(['rules', 'ruleLists', 'activeRuleListId', 'dailyRuleUsage', 'pendingDailyUsageRemaps', 'focusSession', 'rulesGeneration', 'ruleRevisions', 'ruleListRevisions']),
      ...await browser.storage.sync.get(['credentials', 'settings']), dnr: await browser.declarativeNetRequest.getDynamicRules()
    }));
  }
  async writeLocal(values) { await this.probe.evaluate(values => browser.storage.local.set(values), values); }
  async licenseConsent() {
    return this.probe.evaluate(async () => {
      const permissions = await browser.permissions.getAll();
      if (!Array.isArray(permissions.data_collection)) return null;
      return permissions.data_collection.includes('authenticationInfo');
    });
  }
  async respondToLicenseConsent(granted) {
    // Native Firefox chrome UI, not a replacement permissions API or pre-grant.
    await this.driver.setContext(firefox.Context.CHROME);
    try {
      await poll(() => this.driver.executeScript(() => {
        const panel = document.getElementById('notification-popup');
        const notification = document.getElementById('addon-webext-permissions-notification');
        return panel?.state === 'open' && Boolean(notification?.getBoundingClientRect().height);
      }), Boolean, 'native optional data-consent prompt');
      const prompt = await this.driver.executeScript(() =>
        document.getElementById('addon-webext-permissions-notification').textContent);
      this.result.consentPrompts ??= [];
      const filename = `native-consent-${this.result.consentPrompts.length + 1}.png`;
      await writeFile(path.join(this.config.output, filename), Buffer.from(await this.driver.takeScreenshot(), 'base64'));
      const evidence = { granted, text: prompt, screenshot: filename, input: 'WebDriver Space' };
      this.result.consentPrompts.push(evidence);
      const button = await poll(() => this.driver.executeScript(accept => {
        const notification = document.getElementById('addon-webext-permissions-notification');
        const host = accept ? notification.button : notification.secondaryButton;
        // Target the focusable HTML button in moz-button's shadow root.
        const nativeButton = host?.buttonEl;
        const rect = nativeButton?.getBoundingClientRect();
        return rect?.width && rect?.height ? nativeButton : null;
      }, granted), Boolean, 'rendered native consent button');
      await poll(() => button.isDisplayed(), Boolean, 'native consent button visible');
      await poll(() => button.isEnabled(), Boolean, 'native consent button enabled');
      await this.driver.executeScript(element => {
        window.__bdE2eConsentActivation = null;
        element.addEventListener('click', event => {
          window.__bdE2eConsentActivation = { trusted: event.isTrusted, detail: event.detail };
        }, { once: true });
      }, button);
      // Native popups use a separate widget. WebDriver's pointer hit test
      // against the browser document cannot scroll them into view. Keyboard
      // input focuses the real button and uses Gecko's native event path.
      await button.sendKeys(Key.SPACE);
      evidence.activation = await this.driver.executeScript(() => window.__bdE2eConsentActivation);
      assert.deepEqual(evidence.activation, { trusted: true, detail: 0 },
        'consent must be activated by trusted keyboard input');
    } finally { await this.driver.setContext(firefox.Context.CONTENT); }
    await equalEventually(() => this.licenseConsent(), granted, 'native authenticationInfo permission');
  }
  async ensureLicenseConsent(page) {
    const consent = await this.licenseConsent();
    if (consent === null) throw new EnvironmentError('This suite requires Firefox native data_collection permissions.');
    if (consent) return;
    await page.click('#proBtn');
    await page.click('#force-sync-btn');
    await this.respondToLicenseConsent(true);
    await page.enabled('#force-sync-btn');
  }
  async openOptions() {
    const page = await this.newPage(`${this.baseUrl}/options/options.html`);
    await page.front();
    await poll(() => page.text('#ext-version'), text => text?.includes(this.manifest.version), 'Options version');
    await page.element('#add-rule');
    const { credentials } = await this.state();
    const paid = credentials.isPro || Date.parse(credentials.installationDate) < Date.parse('2026-01-01T00:00:00Z');
    await page.enabled('#add-whitelist-rule', paid);
    if (paid) await equalEventually(() => page.count('#rule-lists-container .rule-list-card.active-profile'), 1, 'active profile');
    await page.settleOptions();
    this.options.push(page);
    return page;
  }
  async reconcile(page) {
    const response = await send(page, 'rules:activateList', { listId: (await this.state()).activeRuleListId });
    assert.equal(response.success, true, JSON.stringify(response));
    await page.settleOptions();
  }
  holdVerification() {
    const held = new Promise(resolve => { this.releaseVerification = resolve; });
    this.verificationHandler = async () => { await held; return { status: 200, body: { isPro: true } }; };
  }
  async assertBlocked(url, reason = null) {
    const page = await this.newPage(url);
    await poll(() => page.url(), url => url.startsWith(`${this.baseUrl}/blocked.html`), 'native DNR redirect');
    if (reason) assert.equal(new URL(await page.url()).searchParams.get('reason'), reason);
    return page;
  }
  async restart() {
    if (this.config.installation !== 'persistent') throw new EnvironmentError('Restart requires a persistent add-on installation. Use Developer Edition/Nightly or BD_SIGNED_XPI.');
    await this.capture('before-restart');
    await this.driver.quit();
    this.driver = null;
    this.options = [];
    await this.launch({ restarted: true });
  }
  async capture(label) {
    await writeFile(path.join(this.config.output, `${label}-network.json`), JSON.stringify(this.events, null, 2));
    if (!this.driver || !this.probe) return;
    await writeFile(path.join(this.config.output, `${label}-state.json`), JSON.stringify(await this.state(), null, 2));
    for (let index = 0; index < this.options.length; index++) {
      await this.driver.switchTo().window(this.options[index].context);
      await writeFile(path.join(this.config.output, `${label}-options-${index + 1}.png`),
        Buffer.from(await this.driver.takeScreenshot(), 'base64'));
    }
  }
  async close() {
    this.releaseVerification?.();
    try {
      try { await this.capture('final'); } catch (error) { this.result.diagnosticError = error.stack; }
      await writeFile(path.join(this.config.output, 'errors.json'), JSON.stringify({
        pageErrors: this.pageErrors, networkErrors: this.networkErrors,
        verificationCalls: this.verificationCalls
      }, null, 2));
    } finally {
      try { if (this.driver) await this.driver.quit(); else if (this.service) await this.service.kill(); }
      finally {
        if (this.proxy) await this.proxy.close();
        if (this.root) await rm(this.root, { recursive: true, force: true });
      }
    }
  }
}
