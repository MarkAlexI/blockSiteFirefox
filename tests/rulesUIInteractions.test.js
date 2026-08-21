import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

const generalAssignment = {
  listId: 'general',
  disabledByUser: false,
  blockingMode: 'always',
  schedule: null,
  dailyLimit: null
};

async function withRulesUI(callback) {
  const document = new FakeDocument();
  const api = createExtensionApi();
  await withExtensionEnvironment(api, async () => {
    const { RulesUI } = await import('../rules/rulesUI.js');
    await callback({ document, api, rulesUI: new RulesUI() });
  }, { document });
}

function createRule(overrides = {}) {
  return {
    id: 17,
    blockURL: 'example.com',
    redirectURL: '',
    category: 'social',
    assignments: [{ ...generalAssignment }],
    isWhitelist: false,
    ...overrides
  };
}

async function withFakeTimers(callback) {
  const previous = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval
  };
  const timeouts = new Map();
  const intervals = new Map();
  let nextId = 1;

  globalThis.setTimeout = (handler, delay) => {
    const id = nextId++;
    timeouts.set(id, { handler, delay });
    return id;
  };
  globalThis.clearTimeout = id => { timeouts.delete(id); };
  globalThis.setInterval = (handler, delay) => {
    const id = nextId++;
    intervals.set(id, { handler, delay });
    return id;
  };
  globalThis.clearInterval = id => { intervals.delete(id); };

  try {
    await callback({ timeouts, intervals });
  } finally {
    Object.assign(globalThis, previous);
  }
}

test('daily-limit rows show assignment-specific usage and mark exhausted limits', async () => {
  await withRulesUI(({ rulesUI }) => {
    const assignment = { ...generalAssignment, blockingMode: 'daily_limit', dailyLimit: { minutes: 10 } };
    const rule = createRule({ assignments: [assignment] });
    const row = rulesUI.createRuleDisplayRow(
      rule, assignment, 0, () => {}, () => {}, () => {}, true, [], { '17:general': 600 }
    );
    const status = row.querySelector('.daily-limit-status');
    assert.equal(status.textContent, 'daily_limit_usage:10,10');
    assert.equal(status.classList.contains('limit-reached'), true);
    assert.equal(status.title, 'daily_limit_reached');
  });
});

test('invalid daily-limit rows remain visible and expose a localized invalid-state message', async () => {
  await withRulesUI(({ rulesUI }) => {
    const assignment = { ...generalAssignment, blockingMode: 'daily_limit', dailyLimit: null };
    const rule = createRule({ assignments: [assignment] });
    const row = rulesUI.createRuleDisplayRow(rule, assignment, 0, () => {}, () => {}, () => {});
    assert.equal(row.querySelector('.daily-limit-status').textContent, 'daily_limit_invalid');
  });
});

test('scheduled and whitelist rows show their own statuses without exposing ordinary toggle controls', async () => {
  await withRulesUI(({ rulesUI }) => {
    const scheduled = {
      ...generalAssignment,
      blockingMode: 'schedule',
      schedule: { version: 2, periods: [{ days: [1], startTime: '09:00', endTime: '17:00' }] }
    };
    const scheduledRow = rulesUI.createRuleDisplayRow(
      createRule({ assignments: [scheduled] }), scheduled, 0, () => {}, () => {}, () => {}
    );
    assert.notEqual(scheduledRow.children[3].textContent, '');
    assert.equal(scheduledRow.querySelector('.rule-toggle'), null);

    const whitelistRule = createRule({ isWhitelist: true, category: 'whitelist' });
    const whitelistRow = rulesUI.createRuleDisplayRow(
      whitelistRule, generalAssignment, 0, () => {}, () => {}, () => {}
    );
    assert.equal(whitelistRow.children[3].textContent, 'status_allow');
    assert.equal(whitelistRow.children[1].classList.contains('text-disabled'), true);
    assert.equal(whitelistRow.classList.contains('rule-whitelist'), true);
  });
});

test('always-mode row toggles invoke the handler and absorb handler failures', async () => {
  await withRulesUI(async ({ rulesUI }) => {
    const toggled = [];
    const row = rulesUI.createRuleDisplayRow(
      createRule(), generalAssignment, 0, () => {}, () => {}, ruleId => toggled.push(ruleId)
    );
    await row.querySelector('.rule-toggle').dispatch('click');
    assert.deepEqual(toggled, [17]);

    const previousError = console.error;
    console.error = () => {};
    try {
      const failing = rulesUI.createRuleDisplayRow(
        createRule(), generalAssignment, 0, () => {}, () => {}, async () => {
          throw new Error('toggle rejected');
        }
      );
      await failing.querySelector('.rule-toggle').dispatch('click');
    } finally {
      console.error = previousError;
    }
  });
});

test('adding a blacklist rule returns its target, category, blocking config, and selected list', async () => {
  await withFakeTimers(async () => {
    await withRulesUI(async ({ rulesUI }) => {
      const saved = [];
      let cancelled = null;
      const row = rulesUI.createAddRuleRow((...values) => saved.push(values), value => {
        cancelled = value;
      }, true, false, 'list-2');
      row.children[0].querySelector('input').value = 'new.example/path';
      row.children[1].querySelector('input').value = 'https://safe.example/';
      row.querySelector('.category-select').value = 'work';

      await row.querySelector('.save-btn').dispatch('click');
      assert.equal(saved.length, 1);
      assert.equal(saved[0][0], 'new.example/path');
      assert.equal(saved[0][1], 'https://safe.example/');
      assert.equal(saved[0][2], 'work');
      assert.deepEqual(saved[0][3], { blockingMode: 'always', schedule: null, dailyLimit: null });
      assert.equal(saved[0][4], 'list-2');
      assert.equal(saved[0][5], row);
      assert.equal(row.querySelector('.mobile-link-hint').textContent, 'mobilecopylinkhint');

      await row.children.at(-1).children.at(-1).dispatch('click');
      assert.equal(cancelled, row);
    });
  });
});

test('adding a whitelist rule always uses General and disables redirects and category selection', async () => {
  await withFakeTimers(async () => {
    await withRulesUI(async ({ rulesUI }) => {
      const saved = [];
      const row = rulesUI.createAddRuleRow((...values) => saved.push(values), () => {}, true, true, 'list-2');
      row.children[0].querySelector('input').value = 'allowed.example';
      row.children[1].querySelector('input').value = 'https://must-not-save.example/';
      await row.querySelector('.save-btn').dispatch('click');

      assert.equal(row.children[1].querySelector('input').disabled, true);
      assert.equal(row.querySelector('.category-select').disabled, true);
      assert.deepEqual(saved[0].slice(0, 5), [
        'allowed.example',
        '',
        'whitelist',
        { blockingMode: 'always', schedule: null, dailyLimit: null },
        'general'
      ]);
    });
  });
});

test('editing a shared custom-list rule saves only its selected assignment and exposes Remove', async () => {
  await withRulesUI(async ({ rulesUI }) => {
    const assignment = { ...generalAssignment, listId: 'list-1' };
    const rule = createRule({ assignments: [{ ...generalAssignment }, assignment] });
    const saved = [];
    const removed = [];
    let cancelled = false;
    const row = rulesUI.createRuleEditRow(
      rule,
      assignment,
      0,
      (...values) => saved.push(values),
      () => { cancelled = true; },
      (...values) => removed.push(values),
      true
    );
    row.children[0].querySelector('input').value = 'edited.example';
    row.children[1].querySelector('input').value = 'https://safe.example/';
    row.querySelector('.category-select').value = 'news';

    await row.querySelector('.save-btn').dispatch('click');
    assert.deepEqual(saved[0].slice(0, 5), [17, 'list-1', 'edited.example', 'https://safe.example/', 'news']);
    assert.equal(saved[0][6], 'list-1');

    await row.querySelector('.rule-assignment-remove').dispatch('click');
    assert.equal(removed[0][0], 17);
    assert.equal(removed[0][1], 'list-1');
    await row.children.at(-1).children.at(-1).dispatch('click');
    assert.equal(cancelled, true);
  });
});

test('editing a whitelist rule cannot change its General assignment or add a redirect', async () => {
  await withRulesUI(async ({ rulesUI }) => {
    const rule = createRule({ isWhitelist: true, category: 'whitelist' });
    const saved = [];
    const row = rulesUI.createRuleEditRow(
      rule, generalAssignment, 0, (...values) => saved.push(values), () => {}, () => {}, true
    );
    row.children[0].querySelector('input').value = 'allowed.example';
    await row.querySelector('.save-btn').dispatch('click');
    assert.equal(row.children[1].querySelector('input').disabled, true);
    assert.equal(row.querySelector('.category-select').disabled, true);
    assert.deepEqual(saved[0], [
      17,
      'general',
      'allowed.example',
      '',
      'whitelist',
      { blockingMode: 'always', schedule: null, dailyLimit: null },
      'general'
    ]);
  });
});

test('blocking-mode controls preserve advanced existing modes while preventing new Free upgrades', async () => {
  await withRulesUI(({ rulesUI }) => {
    const existing = {
      ...generalAssignment,
      blockingMode: 'daily_limit',
      dailyLimit: { minutes: 45 }
    };
    const section = rulesUI.createBlockingModeSection(existing, false);
    const { modeSelect, dailyInput } = section._blockingModeControls;
    assert.equal(modeSelect.value, 'daily_limit');
    assert.equal(modeSelect.disabled, true);
    assert.equal(dailyInput.disabled, true);
    assert.equal(dailyInput.value, '45');
    assert.equal(modeSelect.children.find(option => option.value === 'schedule').disabled, true);
  });
});

test('advanced blocking modes switch between always, schedule, and validated daily limits', async () => {
  await withRulesUI(async ({ rulesUI }) => {
    const section = rulesUI.createBlockingModeSection(generalAssignment, true);
    const { modeSelect, dailyInput } = section._blockingModeControls;

    modeSelect.value = 'daily_limit';
    await modeSelect.dispatch('change');
    dailyInput.value = '25.9';
    assert.deepEqual(rulesUI.getBlockingConfigFromSection(section), {
      blockingMode: 'daily_limit', schedule: null, dailyLimit: { minutes: 25 }
    });

    dailyInput.value = '0';
    assert.throws(() => rulesUI.getBlockingConfigFromSection(section), /daily_limit_invalid/);
    dailyInput.value = '1441';
    assert.throws(() => rulesUI.getBlockingConfigFromSection(section), /daily_limit_invalid/);

    modeSelect.value = 'schedule';
    await modeSelect.dispatch('change');
    const scheduled = rulesUI.getBlockingConfigFromSection(section);
    assert.equal(scheduled.blockingMode, 'schedule');
    assert.equal(scheduled.schedule.periods.length, 1);

    modeSelect.value = 'always';
    assert.deepEqual(rulesUI.getBlockingConfigFromSection(section), {
      blockingMode: 'always', schedule: null, dailyLimit: null
    });
    assert.deepEqual(rulesUI.getBlockingConfigFromSection(null), {
      blockingMode: 'always', schedule: null, dailyLimit: null
    });
  });
});

test('invalid blocking settings surface localized errors instead of invoking Add or Edit callbacks', async () => {
  await withFakeTimers(async () => {
    await withRulesUI(async ({ rulesUI }) => {
      const alerts = [];
      rulesUI.showAlert = message => alerts.push(message);
      const row = rulesUI.createAddRuleRow(() => assert.fail('Invalid rule must not be saved'), () => {}, true);
      const controls = row.querySelector('.blocking-mode-section')._blockingModeControls;
      controls.modeSelect.value = 'daily_limit';
      controls.dailyInput.value = '0';
      await row.querySelector('.save-btn').dispatch('click');
      assert.deepEqual(alerts, ['daily_limit_invalid']);
    });
  });
});

test('status helpers update both inputs and ordinary text nodes without changing unrelated elements', async () => {
  await withRulesUI(({ document, rulesUI }) => {
    const input = document.addElement('status-input', 'input');
    const label = document.addElement('status-label');
    rulesUI.updateStatus(input, 10);
    rulesUI.updateStatus(label, 3);
    assert.equal(input.value, 'savedrules:10');
    assert.equal(label.textContent, 'savedrules:3');

    rulesUI.showSuccessMessage('Saved', input);
    rulesUI.showSuccessMessage('Updated', label);
    assert.equal(input.value, 'Saved');
    assert.equal(label.textContent, 'Updated');
    const empty = rulesUI.createEmptyRow('Nothing to display', 5);
    assert.equal(empty.children[0].colSpan, 5);
    assert.equal(empty.children[0].textContent, 'Nothing to display');
  });
});

test('validation helpers translate known errors and preserve unknown validation codes', async () => {
  await withRulesUI(({ rulesUI }) => {
    const alerts = [];
    rulesUI.showAlert = message => alerts.push(message);
    assert.equal(rulesUI.getValidationMessage('blockurl_empty'), 'blockurl');
    assert.equal(rulesUI.getValidationMessage('redirect_invalid'), 'wrongredirecturl - redirecturlhint');
    assert.equal(rulesUI.getValidationMessage('unknown_code'), 'unknown_code');
    rulesUI.showValidationErrors(['blockurl_empty', 'daily_limit_invalid']);
    assert.deepEqual(alerts, ['blockurl\ndaily_limit_invalid']);
    rulesUI.showErrorMessage('Failure');
    assert.deepEqual(alerts, ['blockurl\ndaily_limit_invalid', 'Failure']);
  });
});

test('ordinary deletion runs immediately while strict deletion starts its confirmation timer', async () => {
  await withRulesUI(({ document, rulesUI }) => {
    const button = document.addElement('delete', 'button');
    let deleted = 0;
    let started = 0;
    rulesUI.handleRuleDeletion(button, () => { deleted += 1; }, false);
    assert.equal(deleted, 1);
    rulesUI.startDeleteCountdown = () => { started += 1; };
    rulesUI.handleRuleDeletion(button, () => { deleted += 1; }, true);
    assert.equal(started, 1);
    assert.equal(deleted, 1);
  });
});

test('strict deletion intentionally enters the blinking delete-ready state before confirmation', async () => {
  await withFakeTimers(async ({ intervals, timeouts }) => {
    await withRulesUI(async ({ document, rulesUI }) => {
      const button = document.addElement('delete', 'button');
      button.textContent = 'Delete';
      let deleted = 0;
      rulesUI.startDeleteCountdown(button, () => { deleted += 1; }, null, 2, 5);
      assert.equal(button.disabled, true);
      assert.equal(button.classList.contains('countdown-active'), true);
      assert.equal(button.textContent, 'Delete (2)');

      const timer = [...intervals.values()][0];
      timer.handler();
      assert.equal(button.textContent, 'Delete (1)');
      timer.handler();
      assert.equal(button.disabled, false);
      assert.equal(button.classList.contains('countdown-active'), false);
      assert.equal(button.classList.contains('delete-ready'), true);
      assert.equal(button.textContent, 'Delete ✓');
      assert.equal([...timeouts.values()][0].delay, 5000);

      await button.dispatch('click');
      assert.equal(deleted, 1);
      rulesUI.cleanup();
    });
  });
});

test('strict deletion resets an expired confirmation and can cancel an active countdown', async () => {
  await withFakeTimers(async ({ intervals, timeouts }) => {
    await withRulesUI(async ({ document, rulesUI }) => {
      const button = document.addElement('delete', 'button');
      button.textContent = 'Delete';
      rulesUI.startDeleteCountdown(button, () => assert.fail('Confirmation expired'), null, 1, 5);
      [...intervals.values()][0].handler();
      [...timeouts.values()][0].handler();
      assert.equal(button.classList.contains('delete-ready'), false);
      assert.equal(button.textContent, 'Delete');

      rulesUI.startDeleteCountdown(button, () => assert.fail('Countdown cancelled'), null, 3, 5);
      await button.dispatch('click', { detail: 2 });
      assert.equal(button.classList.contains('countdown-active'), false);
      assert.equal(button.disabled, false);
      assert.equal(button.textContent, 'Delete');
      rulesUI.cleanup();
    });
  });
});

test('timer cleanup removes countdown and confirmation state without changing the intentional ready styling elsewhere', async () => {
  await withFakeTimers(async ({ intervals }) => {
    await withRulesUI(({ document, rulesUI }) => {
      const button = document.addElement('delete', 'button');
      button.textContent = 'Delete';
      rulesUI.startDeleteCountdown(button, () => {}, null, 5, 5);
      assert.equal(intervals.size, 1);
      rulesUI.clearCountdownTimer(button);
      assert.equal(intervals.size, 0);
      assert.equal(rulesUI.countdownTimers.size, 0);
      assert.equal(button.classList.contains('countdown-active'), false);
      assert.equal(button.classList.contains('delete-ready'), false);
      assert.equal(button.disabled, false);
    });
  });
});
