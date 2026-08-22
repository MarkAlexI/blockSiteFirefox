export const DAILY_RULE_USAGE_KEY = 'dailyRuleUsage';
export const DAILY_LIMIT_STATE_VERSION = 2;
export const MAX_ACCOUNTING_GAP_MS = 90 * 1000;

export function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeUsageKey(value) {
  if (typeof value === 'string' && /^\d+:[^:]+$/.test(value)) return value;
  // Numeric v1 keys are kept temporarily so the migration service can expand
  // them to assignment keys without losing already-accounted usage.
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
}

function normalizeActiveKeys(value) {
  const candidates = Array.isArray(value) ? value : (value == null ? [] : [value]);
  const result = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = normalizeUsageKey(String(candidate));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function normalizeDailyRuleUsageState(raw, now = new Date()) {
  const today = getLocalDateKey(now);
  const sameDay = raw?.date === today;
  const usageSeconds = {};

  if (sameDay && raw?.usageSeconds && typeof raw.usageSeconds === 'object' && !Array.isArray(raw.usageSeconds)) {
    for (const [key, value] of Object.entries(raw.usageSeconds)) {
      const normalizedKey = normalizeUsageKey(key);
      const seconds = Math.floor(Number(value));
      if (normalizedKey && Number.isFinite(seconds) && seconds > 0) {
        usageSeconds[normalizedKey] = seconds;
      }
    }
  }

  let lastSample = null;
  if (sameDay && raw?.lastSample && typeof raw.lastSample === 'object') {
    const timestamp = Number(raw.lastSample.timestamp);
    let assignmentKeys = [];
    if (Array.isArray(raw.lastSample.assignmentKeys)) {
      assignmentKeys = normalizeActiveKeys(raw.lastSample.assignmentKeys);
    } else if (raw.lastSample.ruleId != null) {
      const legacyKey = normalizeUsageKey(String(raw.lastSample.ruleId));
      if (legacyKey) assignmentKeys = [legacyKey];
    }

    if (Number.isFinite(timestamp) && timestamp > 0) {
      lastSample = { timestamp, assignmentKeys };
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
  constructor(storageArea = chrome.storage.local) {
    this.storageArea = storageArea;
    this.enqueue = createAsyncQueue();
  }

  async readState(now = new Date()) {
    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const normalized = normalizeDailyRuleUsageState(result[DAILY_RULE_USAGE_KEY], now);
      const raw = result[DAILY_RULE_USAGE_KEY];
      const needsSave = !raw || JSON.stringify(raw) !== JSON.stringify(normalized);
      if (needsSave) await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: normalized });
      return normalized;
    });
  }

  async getUsageSeconds(now = new Date()) {
    const state = await this.readState(now);
    return { ...state.usageSeconds };
  }

  async recordSample(activeAssignmentKeys, now = new Date(), { closePreviousSegment = false } = {}) {
    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const state = normalizeDailyRuleUsageState(result[DAILY_RULE_USAGE_KEY], now);
      const timestamp = now.getTime();
      const currentKeys = normalizeActiveKeys(activeAssignmentKeys);
      const previousKeys = state.lastSample?.assignmentKeys || [];
      const sharedKeys = previousKeys.filter(key => currentKeys.includes(key));
      const accountingKeys = closePreviousSegment ? previousKeys : sharedKeys;
      let addedSeconds = 0;

      const previous = state.lastSample;
      if (previous) {
        const elapsedMs = timestamp - previous.timestamp;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        if (elapsedMs > 0 && elapsedMs <= MAX_ACCOUNTING_GAP_MS) {
          addedSeconds = elapsedSeconds;
        }
      }

      const usageUpdates = {};
      if (addedSeconds > 0) {
        for (const key of accountingKeys) {
          const previousUsageSeconds = Math.max(0, Number(state.usageSeconds[key]) || 0);
          const currentUsageSeconds = previousUsageSeconds + addedSeconds;
          state.usageSeconds[key] = currentUsageSeconds;
          usageUpdates[key] = { previousUsageSeconds, currentUsageSeconds };
        }
      }

      state.lastSample = {
        timestamp,
        assignmentKeys: currentKeys
      };

      await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
      return {
        state,
        accountedAssignmentKeys: Object.keys(usageUpdates),
        addedSeconds,
        usageUpdates
      };
    });
  }

  async resetSample(now = new Date()) {
    return this.recordSample([], now, { closePreviousSegment: true });
  }

  async remapAssignmentKey(oldRuleId, oldListId, newRuleId, newListId, now = new Date()) {
    const oldId = Math.floor(Number(oldRuleId));
    const newId = Math.floor(Number(newRuleId));
    const oldList = typeof oldListId === 'string' ? oldListId.trim() : '';
    const newList = typeof newListId === 'string' ? newListId.trim() : '';
    if (!Number.isInteger(oldId) || oldId <= 0 || !Number.isInteger(newId) || newId <= 0 || !oldList || !newList) {
      return null;
    }
    const oldKey = `${oldId}:${oldList}`;
    const newKey = `${newId}:${newList}`;
    if (oldKey === newKey) return this.readState(now);

    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const state = normalizeDailyRuleUsageState(result[DAILY_RULE_USAGE_KEY], now);
      const oldUsage = Math.max(0, Number(state.usageSeconds[oldKey]) || 0);
      const newUsage = Math.max(0, Number(state.usageSeconds[newKey]) || 0);
      if (oldUsage > 0 || newUsage > 0) {
        state.usageSeconds[newKey] = Math.max(oldUsage, newUsage);
      }
      delete state.usageSeconds[oldKey];
      if (state.lastSample) {
        state.lastSample.assignmentKeys = normalizeActiveKeys(
          state.lastSample.assignmentKeys.map(key => key === oldKey ? newKey : key)
        );
      }
      await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
      return state;
    });
  }

  async pruneAssignmentKeys(validAssignmentKeys, now = new Date()) {
    const valid = new Set(normalizeActiveKeys(validAssignmentKeys));
    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const state = normalizeDailyRuleUsageState(result[DAILY_RULE_USAGE_KEY], now);
      for (const key of Object.keys(state.usageSeconds)) {
        if (!valid.has(key)) delete state.usageSeconds[key];
      }
      if (state.lastSample) {
        state.lastSample.assignmentKeys = state.lastSample.assignmentKeys.filter(key => valid.has(key));
      }
      await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
      return state;
    });
  }
}
