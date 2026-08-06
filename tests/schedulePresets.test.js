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
