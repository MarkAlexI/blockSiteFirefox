export const FOCUS_SCHEDULE_KEY = 'focusSchedule';
export const FOCUS_SCHEDULE_ALARM = 'start_scheduled_focus';

export function defaultFocusSchedule() {
  return { version: 1, enabled: false, days: [1, 2, 3, 4, 5], startTime: '09:00',
    durationMinutes: 25, revision: 0, notBefore: 0, handledKeys: [], skippedKeys: [] };
}

export function validateFocusSchedule(input) {
  const allowed = ['enabled', 'days', 'startTime', 'durationMinutes'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.includes(key)) ||
      typeof input.enabled !== 'boolean' ||
      !Array.isArray(input.days) || input.days.length < 1 || input.days.length > 7 ||
      input.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(input.days).size !== input.days.length ||
      typeof input.startTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.startTime) ||
      !Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 240) {
    throw Object.assign(new Error('Invalid Focus Session schedule'), { code: 'invalid_focus_schedule' });
  }
  return { enabled: input.enabled, days: [...input.days].sort(), startTime: input.startTime,
    durationMinutes: input.durationMinutes };
}

export function readFocusSchedule(value) {
  const fallback = defaultFocusSchedule();
  if (!value || value.version !== 1) return fallback;
  try {
    const config = validateFocusSchedule({ enabled: value.enabled, days: value.days,
      startTime: value.startTime, durationMinutes: value.durationMinutes });
    const keys = list => Array.isArray(list)
      ? [...new Set(list.filter(key => typeof key === 'string' && /^\d{4}-\d{2}-\d{2}@\d{2}:\d{2}$/.test(key)))].slice(-32)
      : [];
    return { ...fallback, ...config,
      revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
      notBefore: Number.isFinite(value.notBefore) && value.notBefore >= 0 ? value.notBefore : 0,
      handledKeys: keys(value.handledKeys), skippedKeys: keys(value.skippedKeys) };
  } catch {
    // Corrupt or future state must never enable automatic blocking.
    return fallback;
  }
}

export function focusOccurrences(schedule, now = Date.now()) {
  if (!schedule.enabled) return [];
  const today = new Date(now);
  const [hours, minutes] = schedule.startTime.split(':').map(Number);
  const occurrences = [];
  // Yesterday covers overnight sessions. The horizon includes skipped weeks.
  for (let offset = -1; offset <= 370; offset++) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, hours, minutes);
    // A missing wall-clock time during the spring DST jump is skipped.
    if (start.getHours() !== hours || start.getMinutes() !== minutes || !schedule.days.includes(start.getDay())) continue;
    const startTime = start.getTime();
    const endTime = startTime + schedule.durationMinutes * 60_000;
    if (startTime < schedule.notBefore || endTime <= now) continue;
    const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    occurrences.push({ key: `${date}@${schedule.startTime}`, startTime, endTime });
  }
  return occurrences;
}

export function nextFocusOccurrence(schedule, now = Date.now()) {
  return focusOccurrences(schedule, now).find(item =>
    !schedule.handledKeys.includes(item.key) && !schedule.skippedKeys.includes(item.key)) || null;
}
