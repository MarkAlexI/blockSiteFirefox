import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSchedule } from '../schedules/scheduleValidator.js';

test('multi-period schedules accept disjoint day groups', () => {
  const result = validateSchedule({
    version: 2,
    periods: [
      { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
      { days: [0, 6], startTime: '11:00', endTime: '14:00' }
    ]
  });

  assert.deepEqual(result, { isValid: true, errors: [] });
});

test('a day cannot belong to more than one time group', () => {
  const result = validateSchedule({
    version: 2,
    periods: [
      { days: [1, 2], startTime: '09:00', endTime: '17:00' },
      { days: [2, 3], startTime: '18:00', endTime: '20:00' }
    ]
  });

  assert.deepEqual(result, {
    isValid: false,
    errors: ['schedule_day_overlap']
  });
});

test('schedule validation preserves distinct localization error keys', () => {
  const result = validateSchedule({
    version: 2,
    periods: [
      { days: [], startTime: 'bad', endTime: '17:00' },
      { days: [9], startTime: '18:00', endTime: '18:00' }
    ]
  });

  assert.deepEqual(result, {
    isValid: false,
    errors: ['invalid_days', 'invalid_time_format', 'start_after_end']
  });
});

test('legacy schedules remain valid input', () => {
  assert.deepEqual(
    validateSchedule({ days: [2], startTime: '10:00', endTime: '11:00' }),
    { isValid: true, errors: [] }
  );
});

test('overnight schedules accept an ending time on the next selected-day interval', () => {
  assert.deepEqual(validateSchedule({
    version: 2,
    periods: [{ days: [1, 5], startTime: '22:00', endTime: '06:00' }]
  }), { isValid: true, errors: [] });
});

test('legacy overnight schedules remain valid without changing their stored shape', () => {
  assert.deepEqual(
    validateSchedule({ days: [0], startTime: '23:30', endTime: '05:45' }),
    { isValid: true, errors: [] }
  );
});

test('mixed day and overnight groups keep their independent selected start days', () => {
  assert.deepEqual(validateSchedule({
    version: 2,
    periods: [
      { days: [1, 2, 3, 4, 5], startTime: '22:00', endTime: '06:00' },
      { days: [0, 6], startTime: '09:00', endTime: '17:00' }
    ]
  }), { isValid: true, errors: [] });
});

test('zero-duration periods remain invalid at midnight and at other hours', () => {
  for (const time of ['00:00', '12:30', '23:59']) {
    assert.deepEqual(validateSchedule({ days: [1], startTime: time, endTime: time }), {
      isValid: false,
      errors: ['start_after_end']
    }, time);
  }
});

test('overnight groups still reject a repeated selected start weekday', () => {
  assert.deepEqual(validateSchedule({
    version: 2,
    periods: [
      { days: [1, 2], startTime: '22:00', endTime: '06:00' },
      { days: [2, 3], startTime: '20:00', endTime: '04:00' }
    ]
  }), {
    isValid: false,
    errors: ['schedule_day_overlap']
  });
});

test('one-minute overnight intervals and all seven selected start days remain valid', () => {
  assert.deepEqual(validateSchedule({
    version: 2,
    periods: [{ days: [0, 1, 2, 3, 4, 5, 6], startTime: '23:59', endTime: '00:00' }]
  }), { isValid: true, errors: [] });
});

test('overnight scheduling does not weaken strict local time validation', () => {
  for (const [startTime, endTime] of [['24:00', '06:00'], ['22:00', '6:00'], ['22:61', '00:00']]) {
    assert.deepEqual(validateSchedule({ days: [1], startTime, endTime }), {
      isValid: false,
      errors: ['invalid_time_format']
    });
  }
});
