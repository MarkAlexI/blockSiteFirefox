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
      { days: [9], startTime: '18:00', endTime: '17:00' }
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
