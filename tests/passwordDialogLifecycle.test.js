import test from 'node:test';
import assert from 'node:assert/strict';
import { PasswordUtils } from '../pro/password.js';
import { createPasswordDocument } from './helpers/passwordTestDocument.js';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const t = key => key;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function withDialog(run) {
  const document = createPasswordDocument();
  const api = createExtensionApi({ sync: { settings: { passwordHash: 'stored-hash', enablePassword: true },
    credentials: { licenseKey: 'BD-PRO-TEST' } } });
  const element = id => document.getElementById(id);
  await withExtensionEnvironment(api, () => run({ document, api, element }), { document });
}

test('password dialog opens with labelled fields, hides unused confirmation and restores its opener', async () => {
  await withDialog(async ({ document, element }) => {
    for (const mode of ['set', 'verify']) {
      const results = [];
      PasswordUtils.showPasswordModal(mode, value => results.push(value), t);
      assert.equal(element('passwordModal').open, true);
      assert.equal(document.activeElement, element('passwordInput1'));
      assert.equal(element('passwordInput1Label').textContent, 'enterpassword');
      assert.equal(element('passwordInput2').hidden, mode !== 'set');
      assert.equal(element('passwordInput2Label').hidden, mode !== 'set');
      assert.equal(element('forgotPassword').hidden, mode === 'set');
      element('passwordInput1').value = 'private-input';
      await element('cancelPassword').dispatch('click');
      assert.equal(document.activeElement, element('password-opener'));
      assert.equal(element('passwordInput1').value, '');
      assert.equal(element('passwordModal').open, false);
      assert.deepEqual(results, mode === 'verify' ? [false] : []);
    }
  });
});

test('Tab boundaries include only visible enabled controls in set, verify and recovery modes', async () => {
  await withDialog(async ({ document, element }) => {
    for (const mode of ['set', 'verify', 'recover']) {
      PasswordUtils.showPasswordModal(mode === 'set' ? 'set' : 'verify', () => {}, t);
      if (mode === 'recover') await element('forgotPassword').dispatch('click');
      const modal = element('passwordModal');
      const last = element(mode === 'verify' ? 'forgotPassword' : 'cancelPassword');
      await modal.dispatch('keydown', { key: 'Tab', shiftKey: true });
      assert.equal(document.activeElement, last);
      await modal.dispatch('keydown', { key: 'Tab', shiftKey: false });
      assert.equal(document.activeElement, element('passwordInput1'));
      await element('cancelPassword').dispatch('click');
    }
  });
});

test('Escape from confirmation and buttons, native cancel and external close all settle verify once', async () => {
  for (const action of ['second-input', 'confirm-button', 'native-cancel', 'external-close']) {
    await withDialog(async ({ element }) => {
      const results = [];
      PasswordUtils.showPasswordModal('verify', value => results.push(value), t);
      if (action === 'native-cancel') await element('passwordModal').dispatch('cancel');
      else if (action === 'external-close') { element('passwordModal').close(); await tick(); }
      else await element('passwordModal').dispatch('keydown', { key: 'Escape',
        target: element(action === 'second-input' ? 'passwordInput2' : 'confirmPassword') });
      await element('cancelPassword').dispatch('click');
      assert.deepEqual(results, [false], action);
      assert.equal(element('passwordModal').open, false);
    });
  }
});

test('Enter works from the confirmation field but IME composition cannot submit', async () => {
  await withDialog(async ({ element }) => {
    const original = PasswordUtils.hashPassword;
    const hashes = [];
    PasswordUtils.hashPassword = async value => { hashes.push(value); return 'new-hash'; };
    try {
      const results = [];
      PasswordUtils.showPasswordModal('set', value => results.push(value), t);
      element('passwordInput1').value = element('passwordInput2').value = 'long-password';
      await element('passwordModal').dispatch('keydown', { key: 'Enter', isComposing: true, target: element('passwordInput2') });
      assert.deepEqual(hashes, []);
      await element('passwordModal').dispatch('keydown', { key: 'Enter', target: element('passwordInput2') });
      await tick();
      assert.deepEqual(hashes, ['long-password']);
      assert.deepEqual(results, ['new-hash']);
    } finally { PasswordUtils.hashPassword = original; }
  });
});

test('validation preserves entries and clears invalid markers on editing without clearing the draft', async () => {
  await withDialog(async ({ element }) => {
    PasswordUtils.showPasswordModal('set', () => {}, t);
    element('passwordInput1').value = 'first-password';
    element('passwordInput2').value = 'other-password';
    await element('confirmPassword').dispatch('click');
    assert.equal(element('passwordInput1').getAttribute('aria-invalid'), 'true');
    assert.equal(element('passwordInput2').getAttribute('aria-invalid'), 'true');
    assert.equal(element('passwordError').textContent, 'passwordmismatch');
    await element('passwordModal').dispatch('input', { target: element('passwordInput2') });
    assert.equal(element('passwordInput2').getAttribute('aria-invalid'), 'false');
    assert.equal(element('passwordInput2').value, 'other-password');
    assert.equal(element('passwordError').textContent, '');
    await element('cancelPassword').dispatch('click');
  });
});

test('cancelled storage reads cannot verify, authorize, or overwrite a reopened prompt', async () => {
  await withDialog(async ({ api, element }) => {
    const read = deferred();
    api.storage.sync.get = () => read.promise;
    const original = PasswordUtils.verifyPassword;
    let checks = 0;
    PasswordUtils.verifyPassword = async () => { checks++; return true; };
    try {
      const results = [];
      PasswordUtils.showPasswordModal('verify', value => results.push(value), t);
      const pending = element('confirmPassword').dispatch('click');
      assert.equal(element('confirmPassword').disabled, true);
      await element('cancelPassword').dispatch('click');
      PasswordUtils.showPasswordModal('set', () => {}, t);
      element('passwordInput1').value = 'new-draft';
      read.resolve({ settings: { passwordHash: 'stored-hash' } });
      await pending;
      assert.deepEqual(results, [false]);
      assert.equal(checks, 0);
      assert.equal(element('passwordInput1').value, 'new-draft');
      assert.equal(element('passwordModal').open, true);
      assert.equal(element('confirmPassword').disabled, false);
      await element('cancelPassword').dispatch('click');
    } finally { PasswordUtils.verifyPassword = original; }
  });
});

test('duplicate confirmation starts one verification and a late valid hash cannot authorize after Escape', async () => {
  await withDialog(async ({ element }) => {
    const hash = deferred();
    const original = PasswordUtils.verifyPassword;
    let checks = 0;
    PasswordUtils.verifyPassword = async () => { checks++; return hash.promise; };
    try {
      const results = [];
      PasswordUtils.showPasswordModal('verify', value => results.push(value), t);
      const first = element('confirmPassword').dispatch('click');
      await tick();
      await element('confirmPassword').dispatch('click');
      assert.equal(checks, 1);
      await element('passwordModal').dispatch('keydown', { key: 'Escape' });
      hash.resolve(true);
      await first;
      assert.deepEqual(results, [false]);
      assert.equal(element('passwordModal').open, false);
    } finally { PasswordUtils.verifyPassword = original; }
  });
});

test('storage and hashing errors retain the draft and restore retry controls with coarse localized text', async () => {
  for (const mode of ['set', 'verify']) await withDialog(async ({ api, element }) => {
    const original = PasswordUtils.hashPassword;
    if (mode === 'set') PasswordUtils.hashPassword = async () => { throw new Error('private hash error'); };
    else api.storage.sync.get = async () => { throw new Error('private storage error'); };
    try {
      PasswordUtils.showPasswordModal(mode, () => assert.fail('must not authorize'), t);
      element('passwordInput1').value = element('passwordInput2').value = 'keep-draft';
      await element('confirmPassword').dispatch('click');
      assert.equal(element('passwordError').textContent, mode === 'set' ? 'errorsavingsettings' : 'errorloadingsettings');
      assert.equal(element('passwordInput1').value, 'keep-draft');
      assert.equal(element('confirmPassword').disabled, false);
      assert.equal(element('cancelPassword').disabled, false);
      assert.equal(element('passwordModal').getAttribute('aria-busy'), 'false');
    } finally { PasswordUtils.hashPassword = original; }
  });
});

test('recovery has a license-key label and cancellation before the read settles prevents a reset', async () => {
  await withDialog(async ({ api, element }) => {
    const read = deferred();
    let writes = 0;
    api.storage.sync.get = () => read.promise;
    api.storage.sync.set = async () => { writes++; };
    const results = [];
    PasswordUtils.showPasswordModal('verify', value => results.push(value), t);
    await element('forgotPassword').dispatch('click');
    assert.equal(element('passwordInput1Label').textContent, 'pastekeylabel');
    assert.equal(element('passwordInput1').type, 'text');
    assert.equal(element('forgotPassword').hidden, true);
    element('passwordInput1').value = 'BD-PRO-TEST';
    const pending = element('confirmPassword').dispatch('click');
    await element('cancelPassword').dispatch('click');
    read.resolve({ credentials: { licenseKey: 'BD-PRO-TEST' }, settings: { enablePassword: true } });
    await pending;
    assert.equal(writes, 0);
    assert.deepEqual(results, [false]);
  });
});

test('a failing recovery write cannot replay or report cancellation after the write began', async () => {
  await withDialog(async ({ api, element }) => {
    const write = deferred();
    let writes = 0;
    api.storage.sync.set = async () => { writes++; return write.promise; };
    const results = [];
    PasswordUtils.showPasswordModal('verify', value => results.push(value), t);
    await element('forgotPassword').dispatch('click');
    element('passwordInput1').value = 'BD-PRO-TEST';
    const pending = element('confirmPassword').dispatch('click');
    await tick();
    await element('confirmPassword').dispatch('click');
    await element('passwordModal').dispatch('cancel');
    assert.equal(element('cancelPassword').disabled, true);
    assert.equal(element('passwordModal').open, true);
    assert.deepEqual(results, []);
    write.reject(new Error('private provider error'));
    await pending;
    assert.equal(writes, 1);
    assert.equal(element('passwordError').textContent, 'errorsavingsettings');
    assert.equal(element('passwordInput1').value, 'BD-PRO-TEST');
    assert.equal(element('cancelPassword').disabled, false);
    await element('cancelPassword').dispatch('click');
    assert.deepEqual(results, [false]);
  });
});

test('a completion callback can immediately open a new dialog without stale cleanup or queued close', async () => {
  await withDialog(async ({ element }) => {
    const original = PasswordUtils.hashPassword;
    PasswordUtils.hashPassword = async () => 'hash';
    try {
      PasswordUtils.showPasswordModal('set', () => {
        PasswordUtils.showPasswordModal('verify', () => {}, t);
        element('passwordInput1').value = 'new-session';
      }, t);
      element('passwordInput1').value = element('passwordInput2').value = 'long-password';
      await element('confirmPassword').dispatch('click');
      await tick();
      assert.equal(element('passwordModal').open, true);
      assert.equal(element('passwordInput1').value, 'new-session');
      assert.equal(element('passwordInput1').readOnly, false);
      await element('cancelPassword').dispatch('click');
    } finally { PasswordUtils.hashPassword = original; }
  });
});

test('a missing opener uses the visible Add action and native open failure denies a waiting verification', async () => {
  await withDialog(async ({ document, element }) => {
    PasswordUtils.showPasswordModal('verify', () => {}, t);
    element('password-opener').remove();
    await element('cancelPassword').dispatch('click');
    assert.equal(document.activeElement, element('add-rule'));
    element('passwordModal').showModal = () => { throw new Error('unavailable dialog'); };
    const results = [];
    PasswordUtils.showPasswordModal('verify', value => results.push(value), t);
    assert.deepEqual(results, [false]);
    assert.equal(element('passwordModal').classList.contains('hidden'), true);
  });
});
