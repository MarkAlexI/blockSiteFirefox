import { t } from '../scripts/t.js';
import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';

export class ScheduleFormatter {
  constructor() {
    this.scheduleDays = [
      t('schedule_day_sun'),
      t('schedule_day_mon'),
      t('schedule_day_tue'),
      t('schedule_day_wed'),
      t('schedule_day_thu'),
      t('schedule_day_fri'),
      t('schedule_day_sat')
    ];
  }

  formatDays(days = []) {
    const sortedDays = [...days].sort((a, b) => a - b);
    const signature = sortedDays.join(',');

    if (signature === '0,1,2,3,4,5,6') {
      return t('schedule_every_day') || 'Every day';
    }
    if (signature === '1,2,3,4,5') {
      return t('schedule_weekdays') || 'Weekdays';
    }
    if (signature === '0,6') {
      return t('schedule_weekends') || 'Weekends';
    }

    return sortedDays.map(day => this.scheduleDays[day]).join(', ');
  }

  formatPeriod(period) {
    const days = this.formatDays(period.days);
    const startTime = period.startTime || '--:--';
    const endTime = period.endTime || '--:--';
    return `${days} ${startTime}-${endTime}`.trim();
  }

  formatSchedule(schedule) {
    if (!schedule) return null;

    const normalized = normalizeSchedule(schedule);
    return normalized.periods
      .map(period => this.formatPeriod(period))
      .join('; ');
  }
}
