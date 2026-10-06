import assert from 'node:assert/strict';
import { send, TEST_KEY, equalEventually, poll } from './fixtures.mjs';

const always = listId => ({ listId, disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null });
const rule = (id, listId, blockURL) => ({ id, blockURL, redirectURL: '', category: 'social', isWhitelist: false, assignments: [always(listId)] });
const focus = () => ({ focusActive: true, focusEndTime: Date.now() + 600_000, isHardcore: false, focusMode: 'blacklist' });
const fixtureRules = () => [rule(901, 'general', 'general.bd-e2e.test'), rule(902, 'list-1', 'study.bd-e2e.test')];
const ids = state => state.dnr.map(item => item.id).sort((a, b) => a - b);

export const recoveryScenarios = ['manual', 'native alarm'].map((trigger, index) => ({
  id: String(14 + index),
  title: `payment recovery through ${trigger} restores cross-list Focus without re-entering the retained key`,
  async run(e) {
    const permissionPage = await e.openOptions(); await e.ensureLicenseConsent(permissionPage);
    await e.seed({ rules: fixtureRules(), active: 'list-1', focus: focus() });
    const a = await e.openOptions(); const b = await e.openOptions(); await e.reconcile(a);
    assert.deepEqual(ids(await e.state()), [901, 902]); const before = await e.state();
    e.verificationHandler = async () => ({ status: 200, body: { isPro: false, licenseValid: true } });
    assert.equal((await send(a, 'force_sync')).success, true);
    const suspended = await e.state();
    assert.equal(suspended.credentials.isPro, false); assert.equal(suspended.credentials.licenseKey, TEST_KEY);
    assert.equal(suspended.activeRuleListId, 'general'); assert.deepEqual(ids(suspended), [901]);
    await b.enabled('#add-whitelist-rule', false);
    e.verificationHandler = async () => ({ status: 200, body: { isPro: true, licenseValid: true } });
    const calls = e.verificationCalls.length;
    if (trigger === 'manual') {
      const response = await send(a, 'force_sync');
      assert.equal(response.success, true); assert.equal(response.isPro, true); assert.notEqual(response.syncPending, true);
      assert.deepEqual(ids(await e.state()), [901, 902]);
    } else {
      await e.probe.evaluate(() => browser.alarms.create('check_pro_expiry', { when: Date.now() + 1000 }));
      await poll(() => e.verificationCalls.length, count => count > calls, 'native alarm verification', 75_000);
      await equalEventually(async () => ids(await e.state()), [901, 902], 'recovery DNR', 75_000);
    }
    const recovered = await e.state();
    assert.equal(recovered.credentials.isPro, true); assert.equal(recovered.credentials.licenseKey, TEST_KEY);
    assert.equal(recovered.activeRuleListId, 'general'); assert.deepEqual(recovered.rules, before.rules);
    assert.deepEqual(recovered.ruleLists, before.ruleLists); assert.deepEqual(recovered.settings, before.settings);
    assert.equal(recovered.focusSession.focusActive, true);
    await a.enabled('#add-whitelist-rule'); await b.enabled('#add-whitelist-rule');
    await e.assertBlocked('http://study.bd-e2e.test/recovered');
  }
}));

recoveryScenarios.push({
  id: '16',
  title: 'verified Pro survives a real browser capacity limit and the next native alarm installs the repaired rule set',
  async run(e) {
    const a = await e.openOptions(); await e.ensureLicenseConsent(a);
    const maximum = await e.probe.evaluate(() => {
      const api = browser.declarativeNetRequest;
      return Math.min(...[api.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
        api.MAX_NUMBER_OF_DYNAMIC_RULES || api.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES].filter(n => Number.isInteger(n) && n > 0));
    });
    assert.ok(maximum > 0 && maximum <= 50_000, 'native DNR capacity available');
    const general = rule(901, 'general', 'general.bd-e2e.test');
    const overflow = Array.from({ length: maximum }, (_, i) => rule(10000 + i, 'list-1', `quota${i}.bd-e2e.test`));
    await e.seed({ pro: false, retainedKey: true, rules: [general, ...overflow], focus: focus() });
    // General still enforces Free rules, but list activation is a paid intent.
    await e.probe.evaluate(() => browser.alarms.create('update_scheduled_rules', { when: Date.now() + 1000 }));
    await equalEventually(async () => ids(await e.state()), [901], 'Free scheduled DNR', 75_000);
    const before = await e.state();
    const response = await send(a, 'force_sync');
    assert.equal(response.success, true); assert.equal(response.isPro, true); assert.equal(response.syncPending, true);
    const pending = await e.state();
    assert.equal(pending.credentials.isPro, true); assert.equal(pending.credentials.licenseKey, TEST_KEY);
    assert.deepEqual(pending.rules, before.rules); assert.deepEqual(pending.ruleLists, before.ruleLists);
    assert.deepEqual(pending.settings, before.settings); assert.deepEqual(ids(pending), [901]);
    await e.writeLocal({ rules: [general, overflow[0]] });
    await e.probe.evaluate(() => browser.alarms.create('update_scheduled_rules', { when: Date.now() + 1000 }));
    await equalEventually(async () => ids(await e.state()), [901, overflow[0].id], 'scheduled DNR repair', 75_000);
    assert.equal((await e.state()).credentials.licenseKey, TEST_KEY);
    await e.assertBlocked('http://quota0.bd-e2e.test/recovered');
  }
}, {
  id: '17',
  title: 'declining native license consent sends no verification request and preserves existing Pro',
  async run(e) {
    const a = await e.openOptions(); const before = await e.state();
    assert.equal(await e.licenseConsent(), false, 'fresh profile has no authenticationInfo grant');
    const calls = e.verificationCalls.length;
    await a.click('#proBtn'); await a.click('#force-sync-btn'); await e.respondToLicenseConsent(false);
    await a.enabled('#force-sync-btn');
    assert.equal(e.verificationCalls.length, calls);
    assert.deepEqual((await e.state()).credentials, before.credentials);
    await a.enabled('#add-whitelist-rule');
    const direct = await send(a, 'force_sync');
    assert.equal(direct.reason, 'consent_required'); assert.equal(e.verificationCalls.length, calls);
    await a.click('#force-sync-btn'); await e.respondToLicenseConsent(true);
    await poll(() => e.verificationCalls.length, count => count > calls, 'verification after native consent');
    await a.enabled('#force-sync-btn');
    assert.equal((await e.state()).credentials.isPro, true);
    assert.equal((await e.state()).credentials.licenseKey, TEST_KEY);
    const permissions = await e.probe.evaluate(() => browser.permissions.getAll());
    assert.equal(permissions.data_collection.includes('technicalAndInteraction'), false);
  }
});
