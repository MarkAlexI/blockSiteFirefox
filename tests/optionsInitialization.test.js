import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const classSource = source.slice(source.indexOf('class OptionsPage {'), source.indexOf('const optionsPage = new OptionsPage();'));
const settle = () => new Promise(resolve => setImmediate(resolve));
const never = () => new Promise(() => {});

function fixture({ telemetry = async () => {}, tips = async () => {}, access = async () => ({
  isPro: false, isLegacyUser: false, credentials: { installationDate: '2026-11-03' }
}) } = {}) {
  const calls = { profiles: 0, failures: 0 };
  const context = vm.createContext({
    window: { bdOptionsRecovery: { begin() {}, ready() {}, fail() { calls.failures++; } } },
    ProManager: { getAccess: access, updateProFeaturesVisibility() {}, initializeProFeatures: async () => {} }
  });
  vm.runInContext(classSource + '\nglobalThis.OptionsClass = OptionsPage;', context);
  const page = Object.create(context.OptionsClass.prototype);
  Object.assign(page, {
    disposed: false, profileRefreshId: 0, proAccessRefreshId: 0,
    initializeUI() {}, setupEventListeners() {}, setupStorageListeners() {},
    rulePacksUI: { initialize() {} }, diagnosticsUI: { initialize() {} },
    telemetryUI: { initialize: telemetry },
    renderStarterTips() {}, invalidateProTips() {}, updateWhitelistButtonState() {},
    renderProTips: tips, async refreshProfileView() { calls.profiles++; },
    logger: { info() {}, error() {} }
  });
  return { page, calls };
}

test('an unanswered telemetry request cannot prevent the initial rules view', async () => {
  const f = fixture({ telemetry: never });
  void f.page.init();
  await settle();
  assert.ok(f.calls.profiles > 0, 'rules must initialize independently of optional telemetry');
});

test('unanswered Pro guidance cannot prevent the rules view after reading access', async () => {
  const f = fixture({ tips: never });
  void f.page.refreshProAccess();
  await settle();
  assert.equal(f.calls.profiles, 1);
});

test('an access-read failure exposes recovery instead of silently leaving an empty rules section', async () => {
  const f = fixture({ access: async () => { throw new Error('Extension context invalidated.'); } });
  await f.page.refreshProAccess();
  assert.equal(f.calls.failures, 1);
  assert.equal(f.calls.profiles, 0, 'failed reads cannot render an invented empty list');
});
