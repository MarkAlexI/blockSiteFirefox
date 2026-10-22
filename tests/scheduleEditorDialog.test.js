import test from 'node:test';
import assert from 'node:assert/strict';

import { ScheduleEditor } from '../schedules/scheduleEditor.js';
import { createDefaultSchedule } from '../schedules/scheduleNormalizer.js';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

import { DialogTestDocument } from './helpers/dialogTestDocument.js';

async function withScheduleEditor(callback) {
  const document = new DialogTestDocument();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    await callback({ document, editor: new ScheduleEditor() });
  }, { document });
}

function getDialog(document) {
  return document.querySelector('.schedule-dialog');
}

test('non-Pro schedule sections show the upgrade message without creating editable controls', async () => {
  await withScheduleEditor(({ editor }) => {
    const section = editor.createSection(null, false);
    assert.match(section.className, /non-pro/);
    assert.equal(section.textContent, 'profeatureschedule');
    assert.equal(section.querySelector('.enable-schedule-toggle'), null);
  });
});

test('schedule dialogs render the existing weekdays, times, presets, and accessible dialog metadata', async () => {
  await withScheduleEditor(({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => {});
    const dialog = getDialog(document);
    assert.equal(editor.isDialogOpen(), true);
    assert.equal(dialog.tagName, 'DIALOG');
    assert.equal(dialog.open, true);
    assert.equal(dialog.getAttribute('aria-label'), 'schedule_edit');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.querySelectorAll('.schedule-period-card').length, 1);
    assert.equal(dialog.querySelectorAll('.schedule-period-days input:checked').length, 5);
    assert.equal(dialog.querySelector('.schedule-period-start').value, '09:00');
    assert.equal(dialog.querySelector('.schedule-period-end').value, '17:00');
    assert.equal(dialog.querySelector('.schedule-presets').children.length, 3);
    assert.equal(document.activeElement?.tagName, 'INPUT');
    editor.closeDialog();
  });
});

test('saving a modified schedule returns its selected days and times and closes the dialog', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    const saved = [];
    editor.openDialog(createDefaultSchedule(), schedule => saved.push(schedule));
    const dialog = getDialog(document);
    const days = dialog.querySelectorAll('.schedule-period-days input');
    days.forEach(day => { day.checked = false; });
    days[0].checked = true;
    days[6].checked = true;
    dialog.querySelector('.schedule-period-start').value = '08:30';
    dialog.querySelector('.schedule-period-end').value = '18:15';

    await dialog.querySelector('.save-btn').dispatch('click');
    assert.deepEqual(saved, [{
      version: 2,
      periods: [{ days: [0, 6], startTime: '08:30', endTime: '18:15' }]
    }]);
    assert.equal(editor.isDialogOpen(), false);
    assert.equal(getDialog(document), null);
  });
});

test('saving without selected days keeps the dialog open and shows a localized validation error', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    let saved = false;
    editor.openDialog(createDefaultSchedule(), () => { saved = true; });
    const dialog = getDialog(document);
    dialog.querySelectorAll('.schedule-period-days input').forEach(input => { input.checked = false; });
    await dialog.querySelector('.save-btn').dispatch('click');
    assert.equal(saved, false);
    assert.equal(dialog.querySelector('.schedule-dialog-error').hidden, false);
    assert.equal(dialog.querySelector('.schedule-dialog-error').textContent, 'invalidscheduledays');
    assert.equal(editor.isDialogOpen(), true);
    editor.closeDialog();
  });
});

test('saving with identical start and end times leaves the draft editable', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => assert.fail('Invalid schedule must not be saved'));
    const dialog = getDialog(document);
    dialog.querySelector('.schedule-period-start').value = '19:00';
    dialog.querySelector('.schedule-period-end').value = '19:00';
    await dialog.querySelector('.save-btn').dispatch('click');
    assert.equal(dialog.querySelector('.schedule-dialog-error').textContent, 'startafterend');
    assert.equal(editor.isDialogOpen(), true);
    editor.closeDialog();
  });
});

test('saving an overnight schedule preserves its selected start weekdays and next-day end', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    const saved = [];
    editor.openDialog(createDefaultSchedule(), schedule => saved.push(schedule));
    const dialog = getDialog(document);
    const days = dialog.querySelectorAll('.schedule-period-days input');
    days.forEach(day => { day.checked = false; });
    days[1].checked = true;
    days[5].checked = true;
    dialog.querySelector('.schedule-period-start').value = '22:00';
    dialog.querySelector('.schedule-period-end').value = '06:00';

    await dialog.querySelector('.save-btn').dispatch('click');

    assert.deepEqual(saved, [{
      version: 2,
      periods: [{ days: [1, 5], startTime: '22:00', endTime: '06:00' }]
    }]);
    assert.equal(editor.isDialogOpen(), false);
  });
});

test('existing overnight schedules reopen without changing their selected start weekdays', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    const original = {
      version: 2,
      periods: [{ days: [0, 6], startTime: '23:15', endTime: '05:45' }]
    };
    const saved = [];
    editor.openDialog(original, schedule => saved.push(schedule));
    const dialog = getDialog(document);

    assert.equal(dialog.querySelector('.schedule-period-start').value, '23:15');
    assert.equal(dialog.querySelector('.schedule-period-end').value, '05:45');
    assert.deepEqual(
      dialog.querySelectorAll('.schedule-period-days input:checked').map(input => Number(input.value)),
      [0, 6]
    );

    await dialog.querySelector('.save-btn').dispatch('click');
    assert.deepEqual(saved, [original]);
  });
});

test('weekday, weekend, and every-day presets replace the selected days and hide old errors', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => {});
    const dialog = getDialog(document);
    const [everyDay, weekdays, weekends] = dialog.querySelector('.schedule-presets').children;
    const selectedDays = () => dialog.querySelectorAll('.schedule-period-days input:checked')
      .map(input => Number(input.value));

    await weekends.dispatch('click');
    assert.deepEqual(selectedDays(), [0, 6]);
    await everyDay.dispatch('click');
    assert.deepEqual(selectedDays(), [0, 1, 2, 3, 4, 5, 6]);
    await weekdays.dispatch('click');
    assert.deepEqual(selectedDays(), [1, 2, 3, 4, 5]);
    assert.equal(dialog.querySelector('.schedule-dialog-error').textContent, '');
    editor.closeDialog();
  });
});

test('changing the selected-day preset keeps an edited overnight interval intact', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    const saved = [];
    editor.openDialog(createDefaultSchedule(), schedule => saved.push(schedule));
    const dialog = getDialog(document);
    dialog.querySelector('.schedule-period-start').value = '22:30';
    dialog.querySelector('.schedule-period-end').value = '05:15';

    await dialog.querySelector('.schedule-presets').children[2].dispatch('click');
    assert.equal(dialog.querySelector('.schedule-period-start').value, '22:30');
    assert.equal(dialog.querySelector('.schedule-period-end').value, '05:15');
    await dialog.querySelector('.save-btn').dispatch('click');

    assert.deepEqual(saved, [{
      version: 2,
      periods: [{ days: [0, 6], startTime: '22:30', endTime: '05:15' }]
    }]);
  });
});

test('adding a schedule period assigns an unused day and periods can be removed again', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => {});
    const dialog = getDialog(document);
    await dialog.querySelector('.schedule-add-period').dispatch('click');
    let periods = dialog.querySelectorAll('.schedule-period-card');
    assert.equal(periods.length, 2);
    assert.deepEqual(periods[1].querySelectorAll('input:checked').map(input => input.value), ['0']);

    await periods[1].querySelector('.schedule-remove-period').dispatch('click');
    periods = dialog.querySelectorAll('.schedule-period-card');
    assert.equal(periods.length, 1);
    editor.closeDialog();
  });
});

test('schedule dialogs cap the number of independent periods at seven', async () => {
  await withScheduleEditor(({ document, editor }) => {
    const schedule = {
      version: 2,
      periods: Array.from({ length: 7 }, (_, day) => ({
        days: [day], startTime: '09:00', endTime: '17:00'
      }))
    };
    editor.openDialog(schedule, () => {});
    const dialog = getDialog(document);
    assert.equal(dialog.querySelectorAll('.schedule-period-card').length, 7);
    assert.equal(dialog.querySelector('.schedule-add-period').disabled, true);
    editor.closeDialog();
  });
});

test('native cancellation closes the dialog without a global keydown listener', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => {});
    const event = await getDialog(document).dispatch('cancel');
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.equal(editor.isDialogOpen(), false);
    assert.equal((document.listeners.get('keydown') || []).length, 0);
  });
});

test('backdrop clicks close the dialog while clicks in its padding keep it open', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => {});
    const dialog = getDialog(document);
    await dialog.dispatch('click', { clientX: 40, clientY: 40 });
    assert.equal(editor.isDialogOpen(), true);
    await dialog.dispatch('click', { clientX: 0, clientY: 0 });
    assert.equal(editor.isDialogOpen(), false);

    editor.openDialog(createDefaultSchedule(), () => {});
    const footer = getDialog(document).querySelector('.schedule-dialog-actions');
    await footer.children.at(-2).dispatch('click');
    assert.equal(editor.isDialogOpen(), false);
  });
});

test('opening a second dialog closes the first and mounts the replacement in its requested host', async () => {
  await withScheduleEditor(({ document, editor }) => {
    const host = document.addElement('host');
    editor.openDialog(createDefaultSchedule(), () => {});
    assert.equal(document.body.querySelectorAll('.schedule-dialog').length, 1);
    editor.openDialog(createDefaultSchedule(), () => {}, { dialogHost: host });
    assert.equal(host.querySelectorAll('.schedule-dialog').length, 1);
    assert.equal(document.body.querySelectorAll('.schedule-dialog').length, 1);
    editor.closeDialog();
  });
});

test('an edited schedule is saved back into its section and remains enabled', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    const section = editor.createSection(null, true);
    document.body.appendChild(section);
    await section.querySelector('.schedule-edit-button').dispatch('click');
    const dialog = getDialog(document);
    await dialog.querySelector('.schedule-presets').children[2].dispatch('click');
    await dialog.querySelector('.save-btn').dispatch('click');
    assert.equal(section.querySelector('.enable-schedule-toggle').checked, true);
    assert.deepEqual(editor.getSchedule(section).periods[0].days, [0, 6]);
  });
});

test('disabled or invalid schedule sections cannot produce a usable schedule', async () => {
  await withScheduleEditor(({ editor }) => {
    assert.equal(editor.getSchedule(null), null);
    assert.equal(editor.getSchedule({ nodeType: 3 }), null);
    const section = editor.createSection(createDefaultSchedule(), true);
    section.querySelector('.enable-schedule-toggle').checked = false;
    assert.equal(editor.getSchedule(section), null);

    section.querySelector('.enable-schedule-toggle').checked = true;
    editor.scheduleState.set(section, {
      version: 2,
      periods: [{ days: [], startTime: '09:00', endTime: '17:00' }]
    });
    assert.throws(() => editor.getSchedule(section), /invalid_days/);
  });
});

test('schedule cancellation, save and external close restore the invoking control exactly once', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    const opener = document.addElement('edit-schedule', 'button');
    for (const action of ['cancel', 'save', 'external']) {
      opener.focus();
      editor.openDialog(createDefaultSchedule(), () => {});
      const dialog = getDialog(document);
      if (action === 'external') dialog.close();
      else if (action === 'save') await dialog.querySelector('.save-btn').dispatch('click');
      else await dialog.dispatch('cancel');
      await Promise.resolve();
      assert.equal(document.activeElement.id, opener.id);
      assert.equal(editor.isDialogOpen(), false);
      assert.equal(dialog.closeCount, 1);
      assert.equal(getDialog(document), null);
    }
  });
});

test('adding and removing time groups leaves keyboard focus in the relevant surviving group', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => {});
    const dialog = getDialog(document);
    await dialog.querySelector('.schedule-add-period').dispatch('click');
    let cards = dialog.querySelectorAll('.schedule-period-card');
    assert.equal(document.activeElement, cards[1].querySelector('input'));
    await cards[1].querySelector('.schedule-remove-period').dispatch('click');
    cards = dialog.querySelectorAll('.schedule-period-card');
    assert.equal(document.activeElement, cards[0].querySelector('input'));
    assert.equal(dialog.querySelector('.schedule-period-start').value, '09:00');
    editor.closeDialog();
  });
});

test('schedule errors identify the invalid group without resetting its edited times', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => {});
    const dialog = getDialog(document);
    const start = dialog.querySelector('.schedule-period-start');
    start.value = '22:30';
    dialog.querySelector('.schedule-period-end').value = '05:15';
    dialog.querySelectorAll('.schedule-period-days input').forEach(input => { input.checked = false; });
    await dialog.querySelector('.save-btn').dispatch('click');
    const error = dialog.querySelector('.schedule-dialog-error');
    assert.equal(error.getAttribute('role'), 'alert');
    assert.equal(document.activeElement.getAttribute('aria-invalid'), 'true');
    assert.equal(document.activeElement.getAttribute('aria-describedby'), error.id);
    assert.equal(start.value, '22:30');
    await dialog.dispatch('input');
    assert.equal(error.textContent, '');
    assert.equal(document.activeElement.getAttribute('aria-invalid'), 'false');
    editor.closeDialog();
  });
});


test('schedule validation focuses an empty end time and the duplicated day in a later group', async () => {
  await withScheduleEditor(async ({ document, editor }) => {
    editor.openDialog(createDefaultSchedule(), () => {});
    const dialog = getDialog(document);
    const end = dialog.querySelector('.schedule-period-end');
    end.value = '';
    await dialog.querySelector('.save-btn').dispatch('click');
    assert.equal(document.activeElement, end);
    assert.equal(end.getAttribute('aria-invalid'), 'true');
    end.value = '17:00';
    await dialog.querySelector('.schedule-add-period').dispatch('click');
    const second = dialog.querySelectorAll('.schedule-period-card')[1];
    const monday = second.querySelector('input[value="1"]');
    monday.checked = true;
    await dialog.querySelector('.save-btn').dispatch('click');
    assert.equal(document.activeElement, monday);
    assert.equal(monday.getAttribute('aria-invalid'), 'true');
    assert.equal(dialog.querySelector('.schedule-dialog-error').textContent, 'schedule_day_overlap');
    editor.closeDialog();
  });
});
