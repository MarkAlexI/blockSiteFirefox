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
const focus = (page, selector) => page.evaluate(selector => document.querySelector(selector).focus(), selector);
async function activate(page, selector, key = 'Enter') { await focus(page, selector); await press(page, key); }
async function namedDialog(page, selector, name) {
  if (page.getByRole) assert.equal(await page.getByRole('dialog', { name, exact: true }).count(), 1);
  else assert.equal(await (await page.element(selector)).getAccessibleName(), name);
}
const message = (page, key) => page.evaluate(key => chrome.i18n.getMessage(key), key);
const scheduleOpen = page => page.evaluate(() => !!document.querySelector('.schedule-dialog[open]'));

export const dialogScenarios = [{
  id: '50',
  title: 'Rule Packs and nested or standalone schedules keep keyboard focus and save one explicit selection',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    await activate(page, '[aria-controls="rules-management-panel"]');
    await activate(page, '#open-rule-packs');
    await namedDialog(page, '#rule-packs-dialog', await message(page, 'rulepacks_title'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rule-packs-select');
    await focus(page, '#rule-packs-close'); await press(page, 'Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rule-packs-add');
    await press(page, 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'rule-packs-close');

    await activate(page, '#rule-packs-schedule-container .enable-schedule-toggle', 'Space');
    const editSchedule = '#rule-packs-schedule-container .schedule-edit-button';
    await activate(page, editSchedule);
    await namedDialog(page, '.schedule-dialog', await message(page, 'schedule_edit'));
    assert.equal(await page.evaluate(() => document.activeElement.type), 'checkbox');
    await focus(page, '.schedule-presets button:first-child'); await press(page, 'Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.schedule-dialog .save-btn')), true);
    await press(page, 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.schedule-presets button:first-child')), true);
    assert.equal(await page.evaluate(() => {
      document.getElementById('rule-packs-select').focus();
      return document.querySelector('.schedule-dialog').contains(document.activeElement);
    }), true, 'native nested dialog makes the parent controls inert');
    for (const day of [1, 2, 3, 4, 5]) await activate(page, `.schedule-period-days input[value="${day}"]`, 'Space');
    await activate(page, '.schedule-dialog .save-btn');
    assert.deepEqual(await page.evaluate(() => {
      const error = document.querySelector('.schedule-dialog-error');
      return [error.getAttribute('role'), error.getAttribute('aria-atomic'),
        document.activeElement.getAttribute('aria-invalid'), document.activeElement.getAttribute('aria-describedby') === error.id];
    }), ['alert', 'true', 'true', true]);
    await activate(page, '.schedule-add-period');
    assert.equal(await page.evaluate(() => document.activeElement.closest('fieldset') === document.querySelectorAll('.schedule-period-card')[1]), true);
    await activate(page, '.schedule-period-card:last-child .schedule-remove-period');
    assert.equal(await page.evaluate(() => document.activeElement.closest('fieldset') === document.querySelector('.schedule-period-card')), true);
    await press(page, 'Escape');
    assert.equal(await scheduleOpen(page), false);
    assert.equal(await page.evaluate(() => document.getElementById('rule-packs-dialog').open), true);
    assert.equal(await page.evaluate(() => document.activeElement.matches('#rule-packs-schedule-container .schedule-edit-button')), true);

    await press(page, 'Enter');
    await activate(page, '.schedule-presets button:last-child');
    await activate(page, '.schedule-dialog .save-btn');
    assert.equal(await scheduleOpen(page), false);
    assert.equal(await page.evaluate(() => document.activeElement.matches('#rule-packs-schedule-container .schedule-edit-button')), true);
    await activate(page, '#rule-packs-select-all', 'Space');
    await activate(page, '#rule-packs-entries .rule-pack-entry:first-child input', 'Space');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#rule-packs-entries input:checked').length), 1);
    await activate(page, '#rule-packs-add');
    await poll(async () => (await e.state()).rules.length, count => count === 1, 'one selected rule committed');
    await poll(() => page.evaluate(() => document.getElementById('rule-packs-announcement').textContent), Boolean, 'result announced');
    const stored = (await e.state()).rules[0];
    assert.deepEqual(stored.assignments[0].schedule.periods[0], { days: [0, 6], startTime: '09:00', endTime: '17:00' });
    assert.equal(await page.evaluate(() => document.getElementById('rule-packs-announcement').getAttribute('aria-atomic')), 'true');
    await press(page, 'Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'open-rule-packs');

    await activate(page, '#rules-container tr[data-rule-id] .actions button:first-child');
    await poll(() => page.evaluate(() => !!document.querySelector('#rules-container .schedule-edit-button')), Boolean, 'scheduled rule editing');
    await activate(page, '#rules-container .schedule-edit-button');
    await namedDialog(page, '.schedule-dialog', await message(page, 'schedule_edit'));
    await press(page, 'Escape');
    assert.equal(await scheduleOpen(page), false);
    assert.equal(await page.evaluate(() => document.activeElement.matches('#rules-container .schedule-edit-button')), true);
    assert.equal((await e.state()).rules.length, 1);
  }
}, {
  id: '51',
  title: 'Feedback has an accessible name, cycles keyboard focus and returns to a popup action after Escape',
  async run(e) {
    await e.seed({ pro: true });
    const dailyHistory = Object.fromEntries([1, 2, 3].map(days =>
      [new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), { blocked: 1 }]));
    await e.writeLocal({ feedbackPromptState: {}, statistics: { totalBlocked: 25, dailyHistory } });
    const page = await e.openPopup();
    await poll(() => page.evaluate(() => document.getElementById('feedback-dialog').open), Boolean, 'eligible feedback shown');
    await namedDialog(page, '#feedback-dialog', await message(page, 'sendfeedbackbutton'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'feedback-close-btn');
    await press(page, 'Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'feedback-support-btn');
    await press(page, 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'feedback-close-btn');
    assert.equal(await page.evaluate(() => {
      document.getElementById('options-link').focus();
      return document.getElementById('feedback-dialog').contains(document.activeElement);
    }), true);
    await press(page, 'Escape');
    assert.equal(await page.evaluate(() => document.getElementById('feedback-dialog').open), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'options-link');
    await poll(() => page.evaluate(async () => (await chrome.storage.local.get('feedbackPromptState')).feedbackPromptState.lastAction), value => value === 'dismissed', 'dismissal saved');
    assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('feedbackPromptState')).feedbackPromptState.promptCount), 1);
    assert.equal((await e.state()).rules.length, 0);
  }
}];
