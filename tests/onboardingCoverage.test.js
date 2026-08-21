import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

test('onboarding translates its UI and handles denied, failed, granted, and existing permissions', async () => {
  const document = new FakeDocument();
  const heading = document.addElement('heading');
  heading.setAttribute('data-i18n', 'onboarding_welcome');
  const input = document.addElement('hint', 'input');
  input.setAttribute('data-i18n', 'onboarding_intro');
  input.setAttribute('data-i18n-placeholder', 'onboarding_button_activate');
  const grant = document.addElement('grant-permission-btn', 'button');
  const status = document.addElement('status-message');
  const api = createExtensionApi();
  let permissionState = false;
  let requestOutcome = false;
  api.permissions = {
    contains(_details, callback) {
      callback(permissionState);
    },
    async request(details) {
      assert.deepEqual(details, { origins: ['*://*/*'] });
      if (requestOutcome instanceof Error) throw requestOutcome;
      return requestOutcome;
    }
  };

  const scheduled = [];
  const previousTimeout = globalThis.setTimeout;
  const previousError = console.error;
  globalThis.setTimeout = (handler, delay) => {
    scheduled.push({ handler, delay });
    return scheduled.length;
  };
  console.error = () => {};

  try {
    await withExtensionEnvironment(api, async () => {
      await import('../onboarding/onboarding.js');
      assert.equal(heading.textContent, 'onboarding_welcome');
      assert.equal(input.getAttribute('placeholder'), 'onboarding_button_activate');
      assert.equal(document.title, 'onboarding_title');

      await document.dispatch('DOMContentLoaded');
      await grant.dispatch('click');
      assert.equal(status.textContent, 'onboarding_status_denied');
      assert.equal(status.className, 'error');
      assert.equal(grant.disabled, false);

      requestOutcome = new Error('permissions unavailable');
      await grant.dispatch('click');
      assert.equal(status.textContent, 'onboarding_status_api_error');
      assert.equal(grant.disabled, false);

      requestOutcome = true;
      await grant.dispatch('click');
      assert.equal(status.textContent, 'onboarding_status_success');
      assert.equal(status.className, 'success');
      assert.equal(grant.style.display, 'none');
      assert.equal(api.messages.some(message => message.type === 'permissions_granted'), true);
      assert.equal(scheduled[0].delay, 3000);
      scheduled[0].handler();
      assert.equal(api.messages.some(message => message.type === 'close_current_tab'), true);

      permissionState = true;
      await document.dispatch('DOMContentLoaded');
      assert.equal(status.textContent, 'onboarding_status_success');
      assert.equal(api.windows, undefined);
    }, { document });
  } finally {
    globalThis.setTimeout = previousTimeout;
    console.error = previousError;
  }
});
