import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultSchedule,
  normalizeSchedule,
  SCHEDULE_VERSION
} from '../schedules/scheduleNormalizer.js';

test('legacy schedules normalize into one version 2 period', () => {
  const legacy = {
    days: [1, 2, 3],
    startTime: '09:00',
    endTime: '17:00'
  };

  assert.deepEqual(normalizeSchedule(legacy), {
    version: SCHEDULE_VERSION,
    periods: [{
      days: [1, 2, 3],
      startTime: '09:00',
      endTime: '17:00'
    }]
  });
});

test('normalization clones periods instead of mutating stored schedules', () => {
  const stored = {
    version: 2,
    periods: [{ days: [1], startTime: '10:00', endTime: '11:00' }]
  };
  const normalized = normalizeSchedule(stored);

  normalized.periods[0].days.push(2);

  assert.deepEqual(stored.periods[0].days, [1]);
});

test('default schedules use weekday working hours', () => {
  assert.deepEqual(createDefaultSchedule(), {
    version: 2,
    periods: [{
      days: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '17:00'
    }]
  });
});
