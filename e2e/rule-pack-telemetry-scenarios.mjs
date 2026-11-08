import assert from 'node:assert/strict';

async function poll(read, check, label) {
  const deadline = Date.now() + 15_000;
  do {
    const value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(label);
}

const press = (page, key) => page.keyboard ? page.keyboard.press(key) : page.press(key);
async function activate(page, selector, key = 'Enter') {
  await page.evaluate(selector => document.querySelector(selector).focus(), selector);
  await press(page, key);
}
const message = (page, input) => page.evaluate(input => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(input, response => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(response);
  });
}), input);

async function privacyPanel(page) {
  const selector = '[aria-controls="privacy-settings-panel"]';
  if (await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded') !== 'true', selector)) {
    await activate(page, selector);
  }
  await poll(() => page.evaluate(() => !document.getElementById('telemetryConsent').disabled),
    Boolean, 'telemetry consent control initialized');
}

async function consent(e, page, enabled) {
  await privacyPanel(page);
  assert.equal(await page.evaluate(() => document.getElementById('telemetryConsent').checked), !enabled);
  const native = await page.evaluate(async () => {
    const permissions = await (globalThis.browser || chrome).permissions.getAll();
    return Array.isArray(permissions.data_collection);
  });
  await activate(page, '#telemetryConsent', 'Space');
  if (native && enabled) await e.respondToLicenseConsent(true, 'technicalAndInteraction');
  await poll(async () => (await message(page, { type: 'telemetry:getConsent' })).consent?.enabled,
    value => value === enabled, 'effective telemetry consent');
  await poll(() => page.evaluate(() => !document.getElementById('telemetryConsent').disabled),
    Boolean, 'telemetry consent change settled');
}

async function openPack(page, entries = ['youtube', 'vimeo']) {
  const panel = '[aria-controls="rules-management-panel"]';
  if (await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded') !== 'true', panel)) {
    await activate(page, panel);
  }
  await activate(page, '#open-rule-packs');
  if (page.locator) await page.locator('#rule-packs-select').selectOption('video');
  else await page.select('#rule-packs-select', 'video');
  await activate(page, '#rule-packs-select-all', 'Space');
  for (const entry of entries) await activate(page, `#rule-packs-entries input[value="${entry}"]`, 'Space');
}

async function addPack(page) {
  await activate(page, '#rule-packs-add');
  await poll(() => page.evaluate(() =>
    document.getElementById('rule-packs-add').getAttribute('aria-busy') === 'false' &&
    !!document.querySelector('#rule-packs-status .rule-packs-result-counts')),
  Boolean, 'Rule Pack result rendered after the mutation reply');
}

const packCounters = payload => Object.fromEntries(Object.entries(payload.batches.reduce((sum, batch) => {
  for (const [name, amount] of Object.entries(batch.counters)) sum[name] = (sum[name] || 0) + amount;
  return sum;
}, {})).filter(([name]) => name.startsWith('rule_pack_')));

export const rulePackTelemetryScenarios = [{
  id: '70', title: 'Rule Packs work without telemetry consent and a forced flush sends no request',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    assert.equal((await message(page, { type: 'telemetry:getConsent' })).consent.enabled, false);
    await openPack(page);
    await addPack(page);
    assert.deepEqual((await e.state()).rules.map(rule => rule.blockURL).sort(), ['vimeo.com', 'youtube.com']);
    const reply = await message(page, { type: 'telemetry:flush', force: true });
    assert.equal(reply.result.reason, 'disabled');
    assert.equal(e.telemetryCalls.length, 0);
    const stored = await e.state(['telemetryBuckets']);
    assert.deepEqual(stored.telemetryBuckets || {}, {});
  }
}, {
  id: '71', title: 'Rule Pack UI counters reach a private retry-stable HTTP payload and stop after consent revocation',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    await consent(e, page, true);
    await openPack(page);
    await addPack(page);
    const committed = structuredClone((await e.state()).rules);
    await addPack(page);
    assert.deepEqual((await e.state()).rules, committed, 'the second addition is a duplicate-only operation');
    await press(page, 'Escape');

    e.telemetryHandler = async () => ({ status: 503, body: { ok: false } });
    const failed = await message(page, { type: 'telemetry:flush', force: true });
    assert.equal(failed.result.success, false);
    assert.equal(e.telemetryCalls.length, 1);
    const first = e.telemetryCalls[0].payload;
    assert.deepEqual(Object.keys(first).sort(), ['batches', 'context', 'schemaVersion', 'sentAt']);
    assert.equal(first.schemaVersion, 3);
    assert.deepEqual(packCounters(first), {
      rule_pack_dialog_opened: 1, rule_pack_attempt_video: 2, rule_pack_imported: 1,
      rule_pack_rules_added: 2, rule_pack_duplicates_skipped: 2, rule_pack_no_change: 1
    });
    for (const batch of first.batches) {
      assert.deepEqual(Object.keys(batch).sort(), ['counters', 'date', 'deliveryId', 'errors']);
      assert.match(batch.deliveryId, /^[0-9a-f-]{36}$/i);
      assert.deepEqual(batch.errors, []);
    }
    for (const privateValue of ['youtube.com', 'vimeo.com', 'BD-E2E-VALID-KEY']) {
      assert.equal(JSON.stringify(first).includes(privateValue), false);
    }
    e.telemetryHandler = async () => ({ status: 202, body: { ok: true } });
    assert.equal((await message(page, { type: 'telemetry:flush', force: true })).result.success, true);
    assert.equal(e.telemetryCalls.length, 2);
    assert.deepEqual(e.telemetryCalls[1].payload.batches, first.batches, 'retry reuses the exact delivery snapshot');
    assert.deepEqual(e.telemetryCalls[1].payload.context, first.context);
    assert.deepEqual((await e.state()).rules, committed, 'delivery never replays the rule mutation');

    await consent(e, page, false);
    await openPack(page, ['twitch']);
    await addPack(page);
    assert.equal((await e.state()).rules.length, 3);
    assert.equal((await message(page, { type: 'telemetry:flush', force: true })).result.reason, 'disabled');
    assert.equal(e.telemetryCalls.length, 2);
    assert.deepEqual((await e.state(['telemetryBuckets'])).telemetryBuckets, {});
  }
}];
