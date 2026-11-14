import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyLimitFocusPolicy } from '../utils/dailyLimitFocusPolicy.js';

for (const navigatorRef of [
  { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/137.0.0.0' },
  { userAgent: 'Desktop mode', platform: 'Android' },
  { userAgent: 'Desktop mode', userAgentData: { platform: 'Android', mobile: false } }
]) test(`Android uses visibility even when Windows API can exist: ${JSON.stringify(navigatorRef)}`, async () => {
  const policy = createDailyLimitFocusPolicy({ navigatorRef,
    runtimeApi: { getPlatformInfo() { throw new Error('unneeded platform query'); } } });
  assert.equal(policy(), false);
});

test('native Android platform detection handles a desktop user agent and caches its result', async () => {
  let calls = 0;
  const policy = createDailyLimitFocusPolicy({ navigatorRef: { userAgent: 'Windows desktop mode' },
    runtimeApi: { async getPlatformInfo() { calls++;return { os: 'android' }; } } });
  const first = policy(), second = policy();
  assert.equal(first, second);
  assert.equal(await first, false);
  assert.equal(policy(), false);
  assert.equal(calls, 1);
});

for (const os of ['win', 'mac', 'linux', 'cros', 'openbsd']) {
  test(`desktop ${os} keeps window focus enforcement and a synchronous cached decision`, async () => {
    const policy = createDailyLimitFocusPolicy({ runtimeApi: { async getPlatformInfo() { return { os }; } } });
    assert.equal(await policy(), true);
    assert.equal(policy(), true);
  });
}

for (const runtimeApi of [{}, { getPlatformInfo() { throw new Error('unsupported'); } },
  { async getPlatformInfo() { return undefined; } }]) {
  test('unknown or unavailable platform detection retains desktop focus checks', async () => {
    const policy = createDailyLimitFocusPolicy({ runtimeApi });
    assert.equal(await policy(), true);
    assert.equal(policy(), true);
  });
}
