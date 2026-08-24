import test from 'node:test';
import assert from 'node:assert/strict';

import { applySchedulePreset } from '../schedules/schedulePresets.js';

test('schedule presets replace day groups while preserving first-period times', () => {
  const schedule = {
    version: 2,
    periods: [
      { days: [2], startTime: '08:30', endTime: '12:15' },
      { days: [6], startTime: '10:00', endTime: '11:00' }
    ]
  };

  assert.deepEqual(applySchedulePreset(schedule, 'weekends'), {
    version: 2,
    periods: [{
      days: [0, 6],
      startTime: '08:30',
      endTime: '12:15'
    }]
  });
});

test('weekday and weekend presets preserve overnight start and next-day end times', () => {
  const original = {
    version: 2,
    periods: [{ days: [2], startTime: '22:45', endTime: '05:30' }]
  };

  assert.deepEqual(applySchedulePreset(original, 'weekdays'), {
    version: 2,
    periods: [{ days: [1, 2, 3, 4, 5], startTime: '22:45', endTime: '05:30' }]
  });
  assert.deepEqual(applySchedulePreset(original, 'weekends'), {
    version: 2,
    periods: [{ days: [0, 6], startTime: '22:45', endTime: '05:30' }]
  });
  assert.deepEqual(original.periods[0].days, [2]);
});
