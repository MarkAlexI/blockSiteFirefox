import { FOCUS_SCHEDULE_KEY, FOCUS_SCHEDULE_ALARM, readFocusSchedule,
  validateFocusSchedule, focusOccurrences, nextFocusOccurrence } from './focusSchedule.js';

/** All mutations share the worker's Focus/Pro transition queue. No network calls. */
export function createFocusScheduleController({ storage, alarms, getAccess, getSession,
  startSession, runExclusive, now = () => Date.now() }) {
  const load = async () => readFocusSchedule((await storage.get(FOCUS_SCHEDULE_KEY))[FOCUS_SCHEDULE_KEY]);
  const write = state => storage.set({ [FOCUS_SCHEDULE_KEY]: state });
  const paid = access => access.isPro === true || access.isLegacyUser === true;
  const handled = (state, key) => ({ ...state, handledKeys: [...new Set([...state.handledKeys, key])].slice(-32) });

  const directStep = (_phase, operation) => operation();

  async function arm(state, step = directStep) {
    const next = nextFocusOccurrence(state, now());
    if (!next) {
      await step('alarm_clear', () => alarms.clear(FOCUS_SCHEDULE_ALARM));
      return;
    }
    const when = Math.max(now() + 1000, next.startTime);
    const existing = await step('alarm_read', () => alarms.get(FOCUS_SCHEDULE_ALARM));
    const scheduledTime = Number(existing?.scheduledTime ?? existing?.when);
    if (!Number.isFinite(scheduledTime) || Math.abs(scheduledTime - when) > 1000) {
      await step('alarm_create', () => alarms.create(FOCUS_SCHEDULE_ALARM, { when }));
    }
  }

  async function status() {
    const [state, access] = await Promise.all([load(), getAccess()]);
    const { enabled, days, startTime, durationMinutes, revision } = state;
    const at = now();
    const upcoming = focusOccurrences(state, at);
    return { config: { enabled, days, startTime, durationMinutes }, revision,
      hasAccess: paid(access), next: nextFocusOccurrence(state, at),
      skipped: upcoming.find(item => state.skippedKeys.includes(item.key)) || null,
      restorable: upcoming.find(item => item.startTime > at && state.skippedKeys.includes(item.key) &&
        !state.handledKeys.includes(item.key)) || null };
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
        const updated = { ...state, revision: state.revision + 1,
          skippedKeys: [...new Set([...state.skippedKeys, key])].slice(-32) };
        await write(updated);
        await arm(updated);
        return status();
      });
    },
    restore(key, expectedRevision, expectedStartTime) {
      return runExclusive(async () => {
        const state = await load();
        if (!paid(await getAccess())) {
          throw Object.assign(new Error('Pro required'), { code: 'pro_required' });
        }
        // Recompute after access lookup: a deadline or timezone may have changed
        // while the request waited. Never revive a handled or ongoing window.
        const at = now();
        const target = focusOccurrences(state, at).find(item => item.key === key &&
          item.startTime === expectedStartTime && item.startTime > at);
        if (state.revision !== expectedRevision || !target ||
            !state.skippedKeys.includes(key) || state.handledKeys.includes(key)) {
          throw Object.assign(new Error('Schedule changed'), { code: 'schedule_changed' });
        }
        const updated = { ...state, revision: state.revision + 1,
          skippedKeys: state.skippedKeys.filter(item => item !== key) };
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
    reconcile(context, step = directStep) {
      return runExclusive(async () => {
        let state = await step('state_read', load);
        const current = nextFocusOccurrence(state, now());
        if (!current || current.startTime > now()) {
          await arm(state, step);
          return { status: 'waiting' };
        }
        const access = await step('access_read', getAccess);
        const session = await step('session_read', getSession);
        // Wall time and timezone can change while the browser APIs are pending.
        const observedNow = now();
        const latest = nextFocusOccurrence(state, observedNow);
        if (!latest || latest.key !== current.key || latest.startTime !== current.startTime ||
            latest.endTime !== current.endTime || latest.startTime > observedNow) {
          await arm(state, step);
          return { status: 'waiting' };
        }
        // Claim durably BEFORE activation: a worker restart must not repeat it.
        // A manual session or missing paid access consumes this occurrence too.
        state = handled(state, current.key);
        await step('state_write', () => write(state));
        let activationFailed = false;
        try {
          if (!paid(access)) return { status: 'pro_required' };
          if (session.focusActive) return { status: 'manual_priority' };
          const activationNow = now();
          if (activationNow >= current.endTime) return { status: 'expired' };
          // Recheck after the durable write. Keep the claim: rolling it back
          // could replay an occurrence after a worker restart.
          const isCurrentWindow = () => {
            const observed = now();
            return focusOccurrences(state, observed).some(item =>
              item.key === current.key && item.startTime === current.startTime &&
              item.endTime === current.endTime && item.startTime <= observed);
          };
          if (!isCurrentWindow()) return { status: 'waiting' };
          return await step('activation', () => startSession(current, context, isCurrentWindow));
        } catch (error) {
          activationFailed = true;
          throw error;
        } finally {
          // Rearming the next occurrence must not delay or prevent this start.
          // Still surface rearm failures, without hiding an activation failure.
          try { await arm(state, step); }
          catch (error) { if (!activationFailed) throw error; }
        }
      });
    }
  };
}
