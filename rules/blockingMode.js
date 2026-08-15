export const BLOCKING_MODE_ALWAYS = 'always';
export const BLOCKING_MODE_SCHEDULE = 'schedule';
export const BLOCKING_MODE_DAILY_LIMIT = 'daily_limit';

export const BLOCKING_MODES = Object.freeze([
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_SCHEDULE,
  BLOCKING_MODE_DAILY_LIMIT
]);

export const MIN_DAILY_LIMIT_MINUTES = 1;
export const MAX_DAILY_LIMIT_MINUTES = 1440;

export function normalizeDailyLimit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const minutes = Math.floor(Number(value.minutes));
  if (!Number.isInteger(minutes) || minutes < MIN_DAILY_LIMIT_MINUTES || minutes > MAX_DAILY_LIMIT_MINUTES) {
    return null;
  }
  return { minutes };
}

export function getRuleBlockingMode(rule = {}) {
  if (rule.isWhitelist === true) return BLOCKING_MODE_ALWAYS;
  if (BLOCKING_MODES.includes(rule.blockingMode)) return rule.blockingMode;
  if (rule.schedule) return BLOCKING_MODE_SCHEDULE;
  if (normalizeDailyLimit(rule.dailyLimit)) return BLOCKING_MODE_DAILY_LIMIT;
  return BLOCKING_MODE_ALWAYS;
}

export function normalizeBlockingConfig(rule = {}) {
  const blockingMode = getRuleBlockingMode(rule);

  if (blockingMode === BLOCKING_MODE_SCHEDULE) {
    return {
      blockingMode,
      schedule: rule.schedule ?? null,
      dailyLimit: null
    };
  }

  if (blockingMode === BLOCKING_MODE_DAILY_LIMIT) {
    return {
      blockingMode,
      schedule: null,
      dailyLimit: normalizeDailyLimit(rule.dailyLimit)
    };
  }

  return {
    blockingMode: BLOCKING_MODE_ALWAYS,
    schedule: null,
    dailyLimit: null
  };
}

export function validateBlockingConfig({ blockingMode, schedule, dailyLimit, isWhitelist = false } = {}) {
  if (isWhitelist) return { isValid: true, errors: [] };

  const errors = [];
  if (!BLOCKING_MODES.includes(blockingMode)) {
    errors.push('blocking_mode_invalid');
    return { isValid: false, errors };
  }

  if (blockingMode === BLOCKING_MODE_ALWAYS) {
    if (schedule || dailyLimit) errors.push('blocking_mode_conflict');
  } else if (blockingMode === BLOCKING_MODE_SCHEDULE) {
    if (!schedule) errors.push('schedule_required');
    if (dailyLimit) errors.push('blocking_mode_conflict');
  } else if (blockingMode === BLOCKING_MODE_DAILY_LIMIT) {
    if (schedule) errors.push('blocking_mode_conflict');
    if (!normalizeDailyLimit(dailyLimit)) errors.push('daily_limit_invalid');
  }

  return { isValid: errors.length === 0, errors };
}

export function getDailyLimitSeconds(rule = {}) {
  if (getRuleBlockingMode(rule) !== BLOCKING_MODE_DAILY_LIMIT) return null;
  const normalized = normalizeDailyLimit(rule.dailyLimit);
  return normalized ? normalized.minutes * 60 : null;
}

export function isDailyLimitReached(rule, usageSeconds = 0) {
  const limitSeconds = getDailyLimitSeconds(rule);
  if (limitSeconds === null) return false;
  return Math.max(0, Number(usageSeconds) || 0) >= limitSeconds;
}
