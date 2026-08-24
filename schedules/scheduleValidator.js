import { normalizeSchedule } from './scheduleNormalizer.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function addUnique(errors, code) {
  if (!errors.includes(code)) errors.push(code);
}

export function validateSchedule(schedule) {
  if (!schedule) {
    return { isValid: true, errors: [] };
  }

  const normalized = normalizeSchedule(schedule);
  const errors = [];
  const usedDays = new Set();

  if (!Array.isArray(normalized.periods) || normalized.periods.length === 0) {
    addUnique(errors, 'invalid_days');
    return { isValid: false, errors };
  }

  for (const period of normalized.periods) {
    const daysAreValid =
      Array.isArray(period.days) &&
      period.days.length > 0 &&
      period.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6) &&
      new Set(period.days).size === period.days.length;

    if (!daysAreValid) {
      addUnique(errors, 'invalid_days');
    } else {
      for (const day of period.days) {
        if (usedDays.has(day)) {
          addUnique(errors, 'schedule_day_overlap');
        }
        usedDays.add(day);
      }
    }

    const hasValidTimeFormat =
      TIME_PATTERN.test(period.startTime || '') &&
      TIME_PATTERN.test(period.endTime || '');

    if (!hasValidTimeFormat) {
      addUnique(errors, 'invalid_time_format');
      continue;
    }

    const [startHour, startMinute] = period.startTime.split(':').map(Number);
    const [endHour, endMinute] = period.endTime.split(':').map(Number);

    if (startHour * 60 + startMinute === endHour * 60 + endMinute) {
      addUnique(errors, 'start_after_end');
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}
