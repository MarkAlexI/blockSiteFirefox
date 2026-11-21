import test from 'node:test';
import assert from 'node:assert/strict';
import { initializePopupLayout } from '../dom/popupLayout.js';

function fixture({ popup = true, os = 'linux' } = {}) {
  const view = { document: { body: { dataset: {} } }, closed: false };
  const calls = [];
  const api = {
    extension: { getViews(filter) { calls.push(filter); return popup ? [view] : []; } },
    runtime: { async getPlatformInfo() { calls.push('platform'); return { os }; } }
  };
  return { api, view, calls };
}

for (const os of ['win', 'mac', 'linux', 'cros', 'openbsd', 'fuchsia']) {
  test(`native ${os} popup selects desktop panel sizing`, async () => {
    const { api, view, calls } = fixture({ os });
    assert.equal(await initializePopupLayout(api, view), 'toolbar');
    assert.equal(view.document.body.dataset.popupSurface, 'toolbar');
    assert.deepEqual(calls, [{ type: 'popup' }, 'platform']);
  });
}

test('a menu tab uses page sizing even if another native popup exists', async () => {
  const { api, view, calls } = fixture();
  api.extension.getViews = filter => { calls.push(filter); return [{ document: view.document }]; };
  assert.equal(await initializePopupLayout(api, view), 'page');
  assert.equal(view.document.body.dataset.popupSurface, 'page');
  assert.deepEqual(calls, [{ type: 'popup' }]);
});

test('Android native views retain page sizing even with desktop-compatible window APIs', async () => {
  const { api, view } = fixture({ os: 'android' });
  assert.equal(await initializePopupLayout(api, view), 'page');
  assert.equal(view.document.body.dataset.popupSurface, 'page');
});

for (const navigator of [{ userAgent: 'Mozilla/5.0 (Linux; Android 15)' },
  { userAgentData: { platform: 'Android' } }, { platform: 'Android' }]) {
  test(`an Android navigator hint keeps page sizing if the browser reports Linux: ${JSON.stringify(navigator)}`, async () => {
    const { api, view, calls } = fixture({ os: 'linux' });
    view.navigator = navigator;
    assert.equal(await initializePopupLayout(api, view), 'page');
    assert.equal(view.document.body.dataset.popupSurface, 'page');
    assert.deepEqual(calls, [], 'Android does not need desktop view or platform lookups');
  });
}

for (const failure of ['missing_api', 'view_error', 'platform_error', 'unknown_platform']) {
  test(`${failure} keeps the menu available with responsive page sizing`, async () => {
    const { api, view } = fixture();
    if (failure === 'view_error') api.extension.getViews = () => { throw new Error('unavailable'); };
    if (failure === 'platform_error') api.runtime.getPlatformInfo = async () => { throw new Error('unavailable'); };
    if (failure === 'unknown_platform') api.runtime.getPlatformInfo = async () => ({});
    assert.equal(await initializePopupLayout(failure === 'missing_api' ? undefined : api, view), 'page');
    assert.equal(view.document.body.dataset.popupSurface, 'page');
  });
}

test('closing the native popup during platform lookup cannot select desktop sizing later', async () => {
  const { api, view } = fixture();
  let finish;
  api.runtime.getPlatformInfo = () => new Promise(resolve => { finish = resolve; });
  const pending = initializePopupLayout(api, view);
  view.closed = true;
  finish({ os: 'linux' });
  assert.equal(await pending, 'page');
  assert.equal(view.document.body.dataset.popupSurface, 'page');
});
