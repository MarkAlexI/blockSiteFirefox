import test from 'node:test';
import assert from 'node:assert/strict';

import { ScheduleFormatter } from '../utils/scheduleFormatter.js';

const previousChrome = globalThis.browser;
globalThis.browser = {
  i18n: {
    getMessage(key) {
      const messages = {
        schedule_day_sun: 'Sun',
        schedule_day_mon: 'Mon',
        schedule_day_tue: 'Tue',
        schedule_day_wed: 'Wed',
        schedule_day_thu: 'Thu',
        schedule_day_fri: 'Fri',
        schedule_day_sat: 'Sat',
        schedule_every_day: 'Every day',
        schedule_weekdays: 'Weekdays',
        schedule_weekends: 'Weekends'
      };
      return messages[key] || key;
    }
  }
};

test.after(() => {
  globalThis.browser = previousChrome;
});

test('formatter keeps legacy schedules readable', () => {
  const formatter = new ScheduleFormatter();
  assert.equal(
    formatter.formatSchedule({
      days: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '17:00'
    }),
    'Weekdays 09:00-17:00'
  );
});

test('formatter joins multiple time groups into a concise summary', () => {
  const formatter = new ScheduleFormatter();
  assert.equal(
    formatter.formatSchedule({
      version: 2,
      periods: [
        { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
        { days: [0, 6], startTime: '11:00', endTime: '14:00' }
      ]
    }),
    'Weekdays 09:00-17:00; Weekends 11:00-14:00'
  );
});
