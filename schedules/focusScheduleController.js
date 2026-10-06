import { FOCUS_SCHEDULE_KEY, FOCUS_SCHEDULE_ALARM, readFocusSchedule,
  validateFocusSchedule, focusOccurrences, nextFocusOccurrence } from './focusSchedule.js';

/** All mutations share the worker's Focus/Pro transition queue. No network calls. */
export function createFocusScheduleController({ storage, alarms, getAccess, getSession,
  startSession, runExclusive, now = () => Date.now() }) {
  const load = async () => readFocusSchedule((await storage.get(FOCUS_SCHEDULE_KEY))[FOCUS_SCHEDULE_KEY]);
  const write = state => storage.set({ [FOCUS_SCHEDULE_KEY]: state });
  const paid = access => access.isPro === true || access.isLegacyUser === true;
  const handled = (state, key) => ({ ...state, handledKeys: [...new Set([...state.handledKeys, key])].slice(-32) });

  async function arm(state) {
    const next = nextFocusOccurrence(state, now());
    if (!next) {
      await alarms.clear(FOCUS_SCHEDULE_ALARM);
      return;
    }
    const when = Math.max(now() + 1000, next.startTime);
    const existing = await alarms.get(FOCUS_SCHEDULE_ALARM);
    const scheduledTime = Number(existing?.scheduledTime ?? existing?.when);
    if (!Number.isFinite(scheduledTime) || Math.abs(scheduledTime - when) > 1000) {
      await alarms.create(FOCUS_SCHEDULE_ALARM, { when });
    }
  }

  async function status() {
    const [state, access] = await Promise.all([load(), getAccess()]);
    const { enabled, days, startTime, durationMinutes, revision } = state;
    const upcoming = focusOccurrences(state, now());
    return { config: { enabled, days, startTime, durationMinutes }, revision,
      hasAccess: paid(access), next: nextFocusOccurrence(state, now()),
      skipped: upcoming.find(item => state.skippedKeys.includes(item.key)) || null };
  }

  return {
    status,
    save(input, expectedRevision) {
      return runExclusive(async () => {
        const config = validateFocusSchedule(input);
        const state = await load();
        if (expectedRevision !== state.revision) {
          throw Object.assign(new Error('Schedule changed in another view'), { code: 'schedule_changed' });
        }
        if (config.enabled && !paid(await getAccess())) {
          throw Object.assign(new Error('Pro required'), { code: 'pro_required' });
        }
        const changed = Object.entries(config).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(state[key]));
        const next = changed ? { ...state, ...config, revision: state.revision + 1,
          notBefore: now(), skippedKeys: [] } : state;
        if (changed) await write(next);
        await arm(next);
        return status();
      });
    },
    skip(key, expectedRevision, expectedStartTime) {
      return runExclusive(async () => {
        const state = await load();
        const next = nextFocusOccurrence(state, now());
        if (state.revision !== expectedRevision || !next || next.key !== key || next.startTime !== expectedStartTime) {
          throw Object.assign(new Error('Schedule changed'), { code: 'schedule_changed' });
        }
        const updated = { ...state, skippedKeys: [...new Set([...state.skippedKeys, key])].slice(-32) };
        await write(updated);
        await arm(updated);
        return status();
      });
    },
    // Called only inside the same transition queue, before a manual start/stop.
    async suppressCurrent() {
      const state = await load();
      const current = focusOccurrences(state, now()).find(item => item.startTime <= now());
      if (current && !state.handledKeys.includes(current.key)) {
        const updated = handled(state, current.key);
        await write(updated);
        await arm(updated);
      }
    },
    reconcile(context) {
      return runExclusive(async () => {
        let state = await load();
        const current = nextFocusOccurrence(state, now());
        if (!current || current.startTime > now()) {
          await arm(state);
          return { status: 'waiting' };
        }
        const access = await getAccess();
        const session = await getSession();
        // Wall time and timezone can change while the browser APIs are pending.
        const observedNow = now();
        const latest = nextFocusOccurrence(state, observedNow);
        if (!latest || latest.key !== current.key || latest.startTime !== current.startTime ||
            latest.endTime !== current.endTime || latest.startTime > observedNow) {
          await arm(state);
          return { status: 'waiting' };
        }
        // Claim durably BEFORE activation: a worker restart must not repeat it.
        // A manual session or missing paid access consumes this occurrence too.
        state = handled(state, current.key);
        await write(state);
        await arm(state);
        if (!paid(access)) return { status: 'pro_required' };
        if (session.focusActive) return { status: 'manual_priority' };
        const activationNow = now();
        if (activationNow >= current.endTime) return { status: 'expired' };
        // Recheck after the durable write and alarm calls too. Keep the claim:
        // rolling it back could replay an occurrence after a worker restart.
        const isCurrentWindow = () => {
          const observed = now();
          return focusOccurrences(state, observed).some(item =>
            item.key === current.key && item.startTime === current.startTime &&
            item.endTime === current.endTime && item.startTime <= observed);
        };
        if (!isCurrentWindow()) return { status: 'waiting' };
        return startSession(current, context, isCurrentWindow);
      });
    }
  };
}
