import test from 'node:test';
import assert from 'node:assert/strict';

import { PasswordUtils } from '../pro/password.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

function createPasswordDocument() {
  const document = new FakeDocument();
  const modal = document.addElement('passwordModal');
  modal.classList.add('hidden');
  document.addElement('modalTitle');
  document.addElement('passwordInput1', 'input');
  document.addElement('passwordInput2', 'input');
  const error = document.addElement('passwordError');
  error.classList.add('hidden');
  document.addElement('forgotPassword', 'button');
  document.addElement('confirmPassword', 'button');
  document.addElement('cancelPassword', 'button');
  return document;
}

const translate = key => key;

test('password hashes use a random 16-byte salt and a 256-bit PBKDF2 digest', async () => {
  const first = await PasswordUtils.hashPassword('correct horse battery staple');
  const second = await PasswordUtils.hashPassword('correct horse battery staple');
  assert.match(first, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test('password verification accepts the matching password and rejects missing or incorrect hashes', async () => {
  const stored = await PasswordUtils.hashPassword('secret-password', '00112233445566778899aabbccddeeff');
  assert.equal(await PasswordUtils.verifyPassword('secret-password', stored), true);
  assert.equal(await PasswordUtils.verifyPassword('wrong-password', stored), false);
  assert.equal(await PasswordUtils.verifyPassword('secret-password', null), false);
});

test('setting a password rejects mismatches and passwords shorter than six characters', async () => {
  const document = createPasswordDocument();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    let completed = false;
    PasswordUtils.showPasswordModal('set', () => { completed = true; }, translate);
    const first = document.getElementById('passwordInput1');
    const second = document.getElementById('passwordInput2');
    const error = document.getElementById('passwordError');
    const confirm = document.getElementById('confirmPassword');

    assert.equal(document.getElementById('passwordModal').classList.contains('hidden'), false);
    assert.equal(second.style.display, 'block');
    assert.equal(document.getElementById('forgotPassword').style.display, 'none');

    first.value = 'password';
    second.value = 'different';
    await confirm.dispatch('click');
    assert.equal(error.textContent, 'passwordmismatch');
    assert.equal(completed, false);

    first.value = 'short';
    second.value = 'short';
    await confirm.dispatch('click');
    assert.equal(error.textContent, 'passwordtooshort');
    assert.equal(completed, false);
  }, { document });
});

test('setting a valid password returns its hash, clears inputs, and unregisters modal handlers', async () => {
  const document = createPasswordDocument();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    const completed = [];
    PasswordUtils.showPasswordModal('set', hash => completed.push(hash), translate);
    const first = document.getElementById('passwordInput1');
    const second = document.getElementById('passwordInput2');
    const confirm = document.getElementById('confirmPassword');
    first.value = '  valid-pass  ';
    second.value = 'valid-pass';

    await confirm.dispatch('click');
    assert.equal(completed.length, 1);
    assert.match(completed[0], /^[0-9a-f]{32}:[0-9a-f]{64}$/);
    assert.equal(await PasswordUtils.verifyPassword('valid-pass', completed[0]), true);
    assert.equal(first.value, '');
    assert.equal(second.value, '');
    assert.equal(confirm.onclick, null);
    assert.equal(document.getElementById('passwordModal').classList.contains('hidden'), true);
  }, { document });
});

test('verifying the stored password succeeds without exposing a second input', async () => {
  const hash = await PasswordUtils.hashPassword('existing-password', '11223344556677889900aabbccddeeff');
  const api = createExtensionApi({ sync: { settings: { passwordHash: hash } } });
  const document = createPasswordDocument();

  await withExtensionEnvironment(api, async () => {
    const completed = [];
    PasswordUtils.showPasswordModal('verify', result => completed.push(result), translate);
    document.getElementById('passwordInput1').value = 'existing-password';
    assert.equal(document.getElementById('passwordInput2').style.display, 'none');
    assert.equal(document.getElementById('forgotPassword').style.display, 'block');
    await document.getElementById('confirmPassword').dispatch('click');
    assert.deepEqual(completed, [true]);
  }, { document });
});

test('an invalid password displays an error and removes the temporary shake state', async () => {
  const hash = await PasswordUtils.hashPassword('existing-password', 'aabbccddeeff00112233445566778899');
  const api = createExtensionApi({ sync: { settings: { passwordHash: hash } } });
  const document = createPasswordDocument();
  const scheduled = [];
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = callback => { scheduled.push(callback); return scheduled.length; };

  try {
    await withExtensionEnvironment(api, async () => {
      let completed = false;
      PasswordUtils.showPasswordModal('verify', () => { completed = true; }, translate);
      const input = document.getElementById('passwordInput1');
      input.value = 'incorrect-password';
      await document.getElementById('confirmPassword').dispatch('click');
      assert.equal(document.getElementById('passwordError').textContent, 'invalidpassword');
      assert.equal(input.classList.contains('shake'), true);
      assert.equal(completed, false);
      scheduled[0]();
      assert.equal(input.classList.contains('shake'), false);
    }, { document });
  } finally {
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('cancelling verification resolves false exactly once, including keyboard Escape', async () => {
  for (const method of ['button', 'escape']) {
    const document = createPasswordDocument();
    await withExtensionEnvironment(createExtensionApi(), async () => {
      const completed = [];
      PasswordUtils.showPasswordModal('verify', result => completed.push(result), translate);
      if (method === 'button') {
        await document.getElementById('cancelPassword').dispatch('click');
      } else {
        await document.getElementById('passwordInput1').dispatch('keydown', { key: 'Escape' });
      }
      assert.deepEqual(completed, [false]);
      assert.equal(document.getElementById('passwordModal').classList.contains('hidden'), true);
      assert.equal(document.getElementById('cancelPassword').onclick, null);
    }, { document });
  }
});

test('cancelling password creation closes the modal without reporting a password', async () => {
  const document = createPasswordDocument();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    let completed = false;
    PasswordUtils.showPasswordModal('set', () => { completed = true; }, translate);
    await document.getElementById('cancelPassword').dispatch('click');
    assert.equal(completed, false);
    assert.equal(document.getElementById('passwordModal').classList.contains('hidden'), true);
  }, { document });
});

test('license-key recovery rejects invalid keys and resets password protection for the matching key', async () => {
  const api = createExtensionApi({ sync: {
    credentials: { licenseKey: 'BD-PRO-VALID-123' },
    settings: { enablePassword: true, passwordHash: 'private-hash', debugMode: true }
  } });
  const document = createPasswordDocument();
  const alerts = [];
  let reloadCount = 0;
  const previousAlert = globalThis.alert;
  globalThis.alert = message => alerts.push(message);

  try {
    await withExtensionEnvironment(api, async () => {
      PasswordUtils.showPasswordModal('verify', () => {}, translate);
      const input = document.getElementById('passwordInput1');
      const forgot = document.getElementById('forgotPassword');
      const confirm = document.getElementById('confirmPassword');
      await forgot.dispatch('click');
      assert.equal(input.type, 'text');
      assert.equal(document.getElementById('modalTitle').textContent, 'restoreaccess');

      input.value = 'BD-PRO-WRONG';
      await confirm.dispatch('click');
      assert.equal(document.getElementById('passwordError').textContent, 'subscriptionnotfound');
      assert.equal(api.storage.sync.data.settings.enablePassword, true);

      input.value = 'BD-PRO-VALID-123';
      await confirm.dispatch('click');
      assert.deepEqual(api.storage.sync.data.settings, {
        enablePassword: false,
        passwordHash: null,
        debugMode: true
      });
      assert.deepEqual(alerts, ['passwordreset']);
      assert.equal(reloadCount, 1);
    }, { document, window: { location: { reload() { reloadCount += 1; } } } });
  } finally {
    if (previousAlert) globalThis.alert = previousAlert;
    else delete globalThis.alert;
  }
});
