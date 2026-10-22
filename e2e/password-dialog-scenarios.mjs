import assert from 'node:assert/strict';

async function poll(read, check, label) {
  const deadline = Date.now() + 15_000;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(label);
}
const press = (page, key) => page.keyboard ? page.keyboard.press(key) : page.press(key);
const fill = (page, selector, value) => page.locator ? page.locator(selector).fill(value) : page.fill(selector, value);
const focus = (page, selector) => page.evaluate(selector => document.querySelector(selector).focus(), selector);
const modalOpen = page => page.evaluate(() => document.getElementById('passwordModal').open === true);

async function assertNames(page, mode) {
  const names = await page.evaluate(mode => {
    const api = typeof browser === 'undefined' ? chrome : browser;
    return { dialog: api.i18n.getMessage(mode === 'set' ? 'setpassword' : mode === 'recover' ? 'restoreaccess' : 'enterpassword'),
      input: api.i18n.getMessage(mode === 'recover' ? 'pastekeylabel' : 'enterpassword') };
  }, mode);
  if (page.getByRole) {
    assert.equal(await page.getByRole('dialog', { name: names.dialog, exact: true }).count(), 1);
    assert.equal(await page.locator('#passwordModal').getByLabel(names.input, { exact: true }).count(), 1);
  } else {
    assert.equal(await (await page.element('#passwordModal')).getAccessibleName(), names.dialog);
    assert.equal(await (await page.element('#passwordInput1')).getAccessibleName(), names.input);
  }
}

export const passwordDialogScenarios = [{
  id: '49',
  title: 'Password dialogs keep native keyboard focus, announce named validation and cancel protected actions before retry',
  async run(e) {
    const rule = { id: 49, blockURL: 'password-dialog.bd-e2e.test', redirectURL: '', category: 'social',
      isWhitelist: false, assignments: [{ listId: 'general', disabledByUser: false,
        blockingMode: 'always', schedule: null, dailyLimit: null }] };
    await e.seed({ pro: true, rules: [rule] });
    const page = await e.openOptions();
    const password = 'BD-dialog-password-49';
    await focus(page, '[aria-controls="security-settings-panel"]');
    await press(page, 'Enter');
    await focus(page, '#enablePassword');
    await press(page, 'Space');
    await poll(() => modalOpen(page), Boolean, 'set-password dialog opened');
    assert.equal(await page.evaluate(() => document.getElementById('passwordModal').tagName), 'DIALOG');
    await assertNames(page, 'set');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'passwordInput1');
    for (const id of ['passwordInput2', 'confirmPassword', 'cancelPassword', 'passwordInput1']) {
      await press(page, 'Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), id);
    }
    await press(page, 'Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'cancelPassword');
    assert.equal(await page.evaluate(() => {
      document.getElementById('add-rule').focus();
      return document.getElementById('passwordModal').contains(document.activeElement);
    }), true, 'the native modal isolates background controls');
    await fill(page, '#passwordInput1', password);
    await fill(page, '#passwordInput2', 'different-password');
    await press(page, 'Enter');
    await poll(() => page.evaluate(() => document.getElementById('passwordError').textContent), Boolean, 'mismatch announced');
    assert.deepEqual(await page.evaluate(() => {
      const error = document.getElementById('passwordError');
      return [error.getAttribute('role'), error.getAttribute('aria-atomic'),
        document.getElementById('passwordInput2').getAttribute('aria-invalid'),
        document.getElementById('passwordInput2').getAttribute('aria-describedby')];
    }), ['alert', 'true', 'true', 'passwordError']);
    await press(page, 'Escape');
    assert.equal(await modalOpen(page), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'enablePassword');
    assert.equal((await e.state()).settings.enablePassword, false);

    await press(page, 'Space');
    await poll(() => modalOpen(page), Boolean, 'set-password reopened');
    await fill(page, '#passwordInput1', password);
    await fill(page, '#passwordInput2', password);
    await press(page, 'Enter');
    await poll(async () => (await e.state()).settings.enablePassword, Boolean, 'password saved once');
    assert.equal(await modalOpen(page), false);

    const deleteButton = '#rules-container tr[data-rule-id="49"] .delete-btn';
    const openVerify = async () => {
      await focus(page, deleteButton);
      await page.evaluate(() => { window.__bdPasswordOpener = document.activeElement; });
      await press(page, 'Enter');
      await poll(() => modalOpen(page), Boolean, 'verification opened');
      await assertNames(page, 'verify');
      assert.equal(await page.evaluate(() => document.getElementById('passwordInput2').hidden), true);
      assert.equal(await page.evaluate(() => document.getElementById('forgotPassword').hidden), false);
    };
    await openVerify();
    await fill(page, '#passwordInput1', 'incorrect-password');
    await press(page, 'Enter');
    await poll(() => page.evaluate(() => document.getElementById('passwordInput1').getAttribute('aria-invalid') === 'true'), Boolean, 'invalid verification');
    await focus(page, '#cancelPassword');
    await press(page, 'Escape');
    assert.equal(await modalOpen(page), false);
    assert.equal(await page.evaluate(() => document.activeElement === window.__bdPasswordOpener), true);
    assert.equal((await e.state()).rules.length, 1, 'cancelled verification must not delete');

    await openVerify();
    await focus(page, '#forgotPassword');
    await press(page, 'Enter');
    await assertNames(page, 'recover');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'passwordInput1');
    assert.equal(await page.evaluate(() => document.getElementById('passwordInput1').type), 'text');
    await press(page, 'Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'cancelPassword');
    await press(page, 'Escape');
    assert.equal((await e.state()).settings.enablePassword, true);

    await openVerify();
    await fill(page, '#passwordInput1', password);
    await press(page, 'Enter');
    await poll(async () => (await e.state()).rules.length, count => count === 0, 'authorized deletion committed');
    assert.equal(await modalOpen(page), false);
    assert.deepEqual(await page.evaluate(() => [document.getElementById('passwordInput1').value,
      document.getElementById('passwordInput2').value]), ['', '']);
  }
}];
