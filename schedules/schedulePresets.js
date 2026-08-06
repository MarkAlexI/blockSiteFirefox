import { SCHEDULE_VERSION } from './scheduleNormalizer.js';

const PRESET_DAYS = Object.freeze({
  everyDay: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6]
});

export function applySchedulePreset(schedule, presetName) {
  const days = PRESET_DAYS[presetName];
  if (!days) return schedule;

  const firstPeriod = schedule?.periods?.[0] || {
    startTime: '09:00',
    endTime: '17:00'
  };

  return {
    version: SCHEDULE_VERSION,
    periods: [{
      days: [...days],
      startTime: firstPeriod.startTime || '09:00',
      endTime: firstPeriod.endTime || '17:00'
    }]
  };
}
