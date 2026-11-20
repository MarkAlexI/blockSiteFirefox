import Logger from './logger.js';

const logger = new Logger('FocusSession');

const DEFAULT_FOCUS_SESSION = {
  focusActive: false,
  focusEndTime: 0,
  isHardcore: false,
  focusMode: 'blacklist'
};

export async function getFocusSessionState({ throwOnError = false } = {}) {
  try {
    const result = await browser.storage.local.get(['focusSession']);
    const stored = result.focusSession;
    if (stored?.focusActive !== true) return { ...DEFAULT_FOCUS_SESSION };

    const focusEndTime = Number(stored.focusEndTime);
    if (!Number.isFinite(focusEndTime) || focusEndTime <= 0 || Date.now() >= focusEndTime) {
      logger.log('Found expired or invalid session, treating as inactive.');
      return { ...DEFAULT_FOCUS_SESSION };
    }

    return {
      focusActive: true,
      focusEndTime,
      isHardcore: stored.isHardcore === true,
      focusMode: stored.focusMode === 'whitelist' ? 'whitelist' : 'blacklist',
      ...(typeof stored.pomodoroId === 'string' ? { pomodoroId: stored.pomodoroId } : {})
    };
  } catch (error) {
    if (throwOnError) throw error;
    logger.error('Error getting state:', error);
    return { ...DEFAULT_FOCUS_SESSION };
  }
}

// Per-operation metadata only: retain original exception identities, including
// when a later rearm failure must not hide the original activation failure.
const FOCUS_RECOVERY_PHASES = new Set([
  'state_read', 'state_write', 'alarm_read', 'alarm_create', 'alarm_clear',
  'access_read', 'session_read', 'activation'
]);

export function createFocusRecoveryTrace() {
  const failures = [];
  return {
    async step(phase, operation) {
      if (!FOCUS_RECOVERY_PHASES.has(phase) || typeof operation !== 'function') {
        throw new TypeError('Unsupported Focus recovery step');
      }
      try { return await operation(); }
      catch (error) {
        failures.push({ error, phase });
        throw error;
      }
    },
    getPhase(error) {
      return failures.find(failure => Object.is(failure.error, error))?.phase || 'unknown';
    }
  };
}

export const POMODORO_KEY = 'pomodoroSession';
export const POMODORO_ALARM = 'pomodoro_break_end';
export const POMODORO_AUTO_GRACE_MS = 60_000;

export const DEFAULT_POMODORO = Object.freeze({
  workMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, rounds: 4,
  autoContinue: false, isHardcore: false, focusMode: 'blacklist'
});

export function normalizePomodoroConfig(input = {}, access = { isPro: true }) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(DEFAULT_POMODORO, key))) {
    throw Object.assign(new Error('Invalid Pomodoro settings'), { code: 'invalid_pomodoro' });
  }
  const config = { ...DEFAULT_POMODORO, ...input };
  for (const key of ['workMinutes', 'breakMinutes', 'longBreakMinutes', 'rounds']) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > (key === 'rounds' ? 12 : 240)) {
      throw Object.assign(new Error('Invalid Pomodoro duration'), { code: 'invalid_pomodoro' });
    }
  }
  if (typeof config.autoContinue !== 'boolean' || typeof config.isHardcore !== 'boolean' ||
      !['blacklist', 'whitelist'].includes(config.focusMode)) {
    throw Object.assign(new Error('Invalid Pomodoro settings'), { code: 'invalid_pomodoro' });
  }
  if (!access.isPro && !access.isLegacyUser && Object.entries(DEFAULT_POMODORO).some(([key, value]) =>
    config[key] !== value)) {
    throw Object.assign(new Error('Pro required'), { code: 'pro_required' });
  }
  return config;
}

export function readPomodoro(stored) {
  if (!stored || stored.schemaVersion !== 1 || typeof stored.id !== 'string' ||
      !/^[a-f\d-]{36}$/i.test(stored.id) || !['work', 'break', 'ready'].includes(stored.phase) ||
      !Number.isInteger(stored.completedRounds)) return null;
  let config;
  try {
    config = normalizePomodoroConfig(Object.fromEntries(Object.keys(DEFAULT_POMODORO).map(key => [key, stored[key]])));
  } catch { return null; }
  if (stored.completedRounds < 0 || stored.completedRounds >= config.rounds ||
      (stored.phase !== 'work' && stored.completedRounds === 0) ||
      !Number.isFinite(stored.phaseEndTime) ||
      (stored.phase === 'ready' ? stored.phaseEndTime !== 0 : stored.phaseEndTime <= 0)) return null;
  return { schemaVersion: 1, id: stored.id, ...config, phase: stored.phase,
    completedRounds: stored.completedRounds, phaseEndTime: stored.phaseEndTime };
}

export function startPomodoro(config, now, id) {
  return { schemaVersion: 1, id, ...config, phase: 'work', completedRounds: 0,
    phaseEndTime: now + config.workMinutes * 60_000 };
}

export function matchesPomodoroWork(cycle, focus) {
  return cycle?.phase === 'work' && focus?.focusActive === true && focus.pomodoroId === cycle.id &&
    Math.abs(focus.focusEndTime - cycle.phaseEndTime) < 1;
}

// Advance exactly one real work interval. Never invent completed work after sleep.
export function completePomodoroWork(cycle, now) {
  const completedRounds = cycle.completedRounds + 1;
  if (completedRounds >= cycle.rounds) return null;
  const minutes = completedRounds % 4 === 0 ? cycle.longBreakMinutes : cycle.breakMinutes;
  const phaseEndTime = cycle.phaseEndTime + minutes * 60_000;
  return { ...cycle, completedRounds,
    phase: now >= phaseEndTime ? 'ready' : 'break', phaseEndTime: now >= phaseEndTime ? 0 : phaseEndTime };
}

export function nextPomodoroWork(cycle, now) {
  return { ...cycle, phase: 'work', phaseEndTime: now + cycle.workMinutes * 60_000 };
}

export function readyPomodoro(cycle) {
  return { ...cycle, phase: 'ready', phaseEndTime: 0 };
}
