import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const optionsSource = fs.readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const popupSource = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

test('Options and Popup refresh when Daily Limit usageSeconds changes', () => {
  for (const source of [optionsSource, popupSource]) {
    assert.match(source, /dailyRuleUsage/);
    assert.match(source, /oldValue\?\.usageSeconds/);
    assert.match(source, /newValue\?\.usageSeconds/);
    assert.match(source, /storage\.onChanged\.addListener\(this\.storageChangeHandler\)/);
    assert.match(source, /storage\.onChanged\.removeListener\(this\.storageChangeHandler\)/);
  }
  assert.match(optionsSource, /void this\.refreshProfileView\(\)/);
  assert.match(popupSource, /void this\.loadRules\(\)/);
});

test('Daily Limit display exposes sub-minute progress instead of staying at zero', async () => {
  const previousChrome = globalThis.chrome;
  const previousBrowser = globalThis.browser;
  globalThis.browser = {
    storage: {
      sync: { async get() { return {}; }, async set() {} },
      onChanged: { addListener() {} }
    },
    i18n: { getMessage(key) { return key; } }
  };
  globalThis.chrome = {
    storage: {
      sync: { get(_keys, callback) { callback({}); }, set() {} },
      onChanged: { addListener() {} }
    },
    i18n: { getMessage(key) { return key; } }
  };

  try {
    const { formatDailyLimitUsageMinutes } = await import('../rules/rulesUI.js');
    assert.equal(formatDailyLimitUsageMinutes(0, 1), '0');
    assert.equal(formatDailyLimitUsageMinutes(6, 1), '0.1');
    assert.equal(formatDailyLimitUsageMinutes(32, 1), '0.5');
    assert.equal(formatDailyLimitUsageMinutes(59, 1), '0.9');
    assert.equal(formatDailyLimitUsageMinutes(60, 1), '1');
    assert.equal(formatDailyLimitUsageMinutes(330, 10), '5.5');
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.browser = previousBrowser;
  }
});
