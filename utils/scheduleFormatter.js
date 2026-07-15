import { t } from '../scripts/t.js';

export class ScheduleFormatter {
  constructor() {
    this.scheduleDays = [
      t("schedule_day_sun"),
      t("schedule_day_mon"),
      t("schedule_day_tue"),
      t("schedule_day_wed"),
      t("schedule_day_thu"),
      t("schedule_day_fri"),
      t("schedule_day_sat")
    ];
  }

  formatSchedule(schedule) {
    if (!schedule) return null;
    
    const daysStr = schedule.days.map(d => this.scheduleDays[d]).join(', ');
    return `${daysStr}, ${schedule.startTime}-${schedule.endTime}`;
  }
}