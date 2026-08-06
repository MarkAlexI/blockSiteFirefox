export const SCHEDULE_VERSION = 2;

function clonePeriod(period = {}) {
  return {
    days: Array.isArray(period.days) ? [...period.days] : [],
    startTime: period.startTime,
    endTime: period.endTime
  };
}

/**
 * Converts both the legacy single-interval schedule and the current multi-period
 * format into one predictable representation without mutating stored data.
 */
export function normalizeSchedule(schedule) {
  if (!schedule) return null;

  if (Array.isArray(schedule.periods)) {
    return {
      version: SCHEDULE_VERSION,
      periods: schedule.periods.map(clonePeriod)
    };
  }

  const hasLegacyShape =
    Object.prototype.hasOwnProperty.call(schedule, 'days') ||
    Object.prototype.hasOwnProperty.call(schedule, 'startTime') ||
    Object.prototype.hasOwnProperty.call(schedule, 'endTime');

  if (hasLegacyShape) {
    return {
      version: SCHEDULE_VERSION,
      periods: [clonePeriod(schedule)]
    };
  }

  return {
    version: SCHEDULE_VERSION,
    periods: []
  };
}

export function createDefaultSchedule() {
  return {
    version: SCHEDULE_VERSION,
    periods: [{
      days: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '17:00'
    }]
  };
}
