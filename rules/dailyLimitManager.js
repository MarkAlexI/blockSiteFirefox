export const DAILY_RULE_USAGE_KEY = 'dailyRuleUsage';
export const DAILY_LIMIT_STATE_VERSION = 1;
export const MAX_ACCOUNTING_GAP_MS = 90 * 1000;

function toRuleId(value) {
  const id = Math.floor(Number(value));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeDailyRuleUsageState(raw, now = new Date()) {
  const today = getLocalDateKey(now);
  const sameDay = raw?.date === today;
  const usageSeconds = {};

  if (sameDay && raw?.usageSeconds && typeof raw.usageSeconds === 'object' && !Array.isArray(raw.usageSeconds)) {
    for (const [key, value] of Object.entries(raw.usageSeconds)) {
      const ruleId = toRuleId(key);
      const seconds = Math.floor(Number(value));
      if (ruleId !== null && Number.isFinite(seconds) && seconds > 0) {
        usageSeconds[String(ruleId)] = seconds;
      }
    }
  }

  let lastSample = null;
  if (sameDay && raw?.lastSample && typeof raw.lastSample === 'object') {
    const timestamp = Number(raw.lastSample.timestamp);
    const ruleId = raw.lastSample.ruleId == null ? null : toRuleId(raw.lastSample.ruleId);
    if (Number.isFinite(timestamp) && timestamp > 0 && (raw.lastSample.ruleId == null || ruleId !== null)) {
      lastSample = { timestamp, ruleId };
    }
  }

  return {
    version: DAILY_LIMIT_STATE_VERSION,
    date: today,
    usageSeconds,
    lastSample
  };
}

function createAsyncQueue() {
  let tail = Promise.resolve();
  return task => {
    const result = tail.then(task, task);
    tail = result.catch(() => {});
    return result;
  };
}

export class DailyLimitManager {
  constructor(storageArea = browser.storage.local) {
    this.storageArea = storageArea;
    this.enqueue = createAsyncQueue();
  }

  async readState(now = new Date()) {
    const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
    const normalized = normalizeDailyRuleUsageState(result[DAILY_RULE_USAGE_KEY], now);
    const raw = result[DAILY_RULE_USAGE_KEY];
    const needsSave = !raw || JSON.stringify(raw) !== JSON.stringify(normalized);
    if (needsSave) await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: normalized });
    return normalized;
  }

  async getUsageSeconds(now = new Date()) {
    const state = await this.readState(now);
    return { ...state.usageSeconds };
  }

  async recordSample(activeRuleId, now = new Date()) {
    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const state = normalizeDailyRuleUsageState(result[DAILY_RULE_USAGE_KEY], now);
      const timestamp = now.getTime();
      const normalizedActiveRuleId = activeRuleId == null ? null : toRuleId(activeRuleId);
      let accountedRuleId = null;
      let addedSeconds = 0;
      let previousUsageSeconds = 0;
      let currentUsageSeconds = 0;

      const previous = state.lastSample;
      if (previous?.ruleId !== null && previous?.ruleId !== undefined) {
        const elapsedMs = timestamp - previous.timestamp;
        if (elapsedMs > 0 && elapsedMs <= MAX_ACCOUNTING_GAP_MS) {
          addedSeconds = Math.floor(elapsedMs / 1000);
          if (addedSeconds > 0) {
            accountedRuleId = previous.ruleId;
            const key = String(previous.ruleId);
            previousUsageSeconds = Math.max(0, Number(state.usageSeconds[key]) || 0);
            currentUsageSeconds = previousUsageSeconds + addedSeconds;
            state.usageSeconds[key] = currentUsageSeconds;
          }
        }
      }

      state.lastSample = {
        timestamp,
        ruleId: normalizedActiveRuleId
      };

      await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
      return {
        state,
        accountedRuleId,
        addedSeconds,
        previousUsageSeconds,
        currentUsageSeconds
      };
    });
  }

  async resetSample(now = new Date()) {
    return this.recordSample(null, now);
  }

  async pruneRuleIds(validRuleIds, now = new Date()) {
    const valid = new Set((validRuleIds || []).map(toRuleId).filter(Boolean).map(String));
    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const state = normalizeDailyRuleUsageState(result[DAILY_RULE_USAGE_KEY], now);
      for (const key of Object.keys(state.usageSeconds)) {
        if (!valid.has(key)) delete state.usageSeconds[key];
      }
      if (state.lastSample?.ruleId != null && !valid.has(String(state.lastSample.ruleId))) {
        state.lastSample.ruleId = null;
      }
      await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
      return state;
    });
  }
}
