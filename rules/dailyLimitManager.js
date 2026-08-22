export const DAILY_RULE_USAGE_KEY = 'dailyRuleUsage';
export const PENDING_DAILY_USAGE_REMAPS_KEY = 'pendingDailyUsageRemaps';
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

function normalizeAssignmentRemaps(remaps = []) {
  const normalized = [];
  for (const remap of Array.isArray(remaps) ? remaps : []) {
    const oldRuleId = Math.floor(Number(remap?.oldRuleId));
    const newRuleId = Math.floor(Number(remap?.newRuleId));
    const oldListId = typeof remap?.oldListId === 'string' ? remap.oldListId.trim() : '';
    const newListId = typeof remap?.newListId === 'string' ? remap.newListId.trim() : '';
    if (!Number.isInteger(oldRuleId) || oldRuleId <= 0 ||
      !Number.isInteger(newRuleId) || newRuleId <= 0 || !oldListId || !newListId) {
      continue;
    }
    const oldKey = `${oldRuleId}:${oldListId}`;
    const newKey = `${newRuleId}:${newListId}`;
    if (oldKey !== newKey) {
      normalized.push({ oldRuleId, oldListId, newRuleId, newListId, oldKey, newKey });
    }
  }
  return normalized;
}

function applyAssignmentRemaps(state, remaps) {
  for (const { oldKey, newKey } of remaps) {
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
  }
  return state;
}

export class DailyLimitManager {
  constructor(storageArea = chrome.storage.local) {
    this.storageArea = storageArea;
    this.enqueue = createAsyncQueue();
    this.pendingRemaps = null;
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
    if (this.pendingRemaps?.length) {
      return applyAssignmentRemaps({
        ...state,
        usageSeconds: { ...state.usageSeconds },
        lastSample: state.lastSample && {
          ...state.lastSample,
          assignmentKeys: [...state.lastSample.assignmentKeys]
        }
      }, this.pendingRemaps).usageSeconds;
    }
    return { ...state.usageSeconds };
  }

  async stagePendingRemaps(statePatch, remaps = []) {
    const normalized = normalizeAssignmentRemaps(remaps);
    return this.enqueue(async () => {
      if (normalized.length === 0) {
        await this.storageArea.set(statePatch);
        return [];
      }

      const result = await this.storageArea.get(PENDING_DAILY_USAGE_REMAPS_KEY);
      const existing = normalizeAssignmentRemaps(result[PENDING_DAILY_USAGE_REMAPS_KEY]);
      let hasTrackedUsage = true;
      if (existing.length === 0) {
        try {
          const storedUsage = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
          const current = normalizeDailyRuleUsageState(storedUsage[DAILY_RULE_USAGE_KEY]);
          hasTrackedUsage = normalized.some(remap =>
            Number(current.usageSeconds[remap.oldKey]) > 0 ||
            current.lastSample?.assignmentKeys.includes(remap.oldKey)
          );
        } catch {
          // If usage cannot be inspected, fail safe by journaling the commit.
          hasTrackedUsage = true;
        }
      }
      if (existing.length === 0 && !hasTrackedUsage) {
        await this.storageArea.set(statePatch);
        this.pendingRemaps = [];
        return [];
      }

      const pending = [...existing, ...normalized];
      const persisted = pending.map(({ oldRuleId, oldListId, newRuleId, newListId }) => ({
        oldRuleId, oldListId, newRuleId, newListId
      }));
      await this.storageArea.set({
        ...statePatch,
        [PENDING_DAILY_USAGE_REMAPS_KEY]: persisted
      });
      this.pendingRemaps = pending;
      return persisted;
    });
  }

  async recoverPendingRemaps(now = new Date()) {
    return this.enqueue(async () => {
      const result = await this.storageArea.get([
        DAILY_RULE_USAGE_KEY,
        PENDING_DAILY_USAGE_REMAPS_KEY
      ]);
      const pending = normalizeAssignmentRemaps(result[PENDING_DAILY_USAGE_REMAPS_KEY]);
      this.pendingRemaps = pending;
      if (pending.length === 0) return { recovered: false, pending: false };

      const raw = result[DAILY_RULE_USAGE_KEY];
      const state = applyAssignmentRemaps(normalizeDailyRuleUsageState(raw, now), pending);
      const patch = { [PENDING_DAILY_USAGE_REMAPS_KEY]: [] };
      if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(state)) {
        patch[DAILY_RULE_USAGE_KEY] = state;
      }
      await this.storageArea.set(patch);
      this.pendingRemaps = [];
      return { recovered: true, pending: false, state };
    });
  }

  async loadPendingRemaps() {
    return this.enqueue(async () => {
      const result = await this.storageArea.get(PENDING_DAILY_USAGE_REMAPS_KEY);
      this.pendingRemaps = normalizeAssignmentRemaps(
        result[PENDING_DAILY_USAGE_REMAPS_KEY]
      );
      return [...this.pendingRemaps];
    });
  }

  async recordSample(activeAssignmentKeys, now = new Date(), { closePreviousSegment = false } = {}) {
    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const raw = result[DAILY_RULE_USAGE_KEY];
      const state = normalizeDailyRuleUsageState(raw, now);
      const timestamp = now.getTime();
      const currentKeys = normalizeActiveKeys(activeAssignmentKeys);
      const previousKeys = state.lastSample?.assignmentKeys || [];

      if (currentKeys.length === 0 && previousKeys.length === 0) {
        if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(state)) {
          await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
        }
        return {
          state,
          accountedAssignmentKeys: [],
          addedSeconds: 0,
          usageUpdates: {}
        };
      }

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

      if (JSON.stringify(raw) !== JSON.stringify(state)) {
        await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
      }
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

    return this.remapAssignmentKeys([{
      oldRuleId: oldId,
      oldListId: oldList,
      newRuleId: newId,
      newListId: newList
    }], now);
  }

  async remapAssignmentKeys(remaps = [], now = new Date()) {
    const normalizedRemaps = normalizeAssignmentRemaps(remaps);

    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const raw = result[DAILY_RULE_USAGE_KEY];
      const state = applyAssignmentRemaps(normalizeDailyRuleUsageState(raw, now), normalizedRemaps);
      if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(state)) {
        await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
      }
      return state;
    });
  }

  async pruneAssignmentKeys(validAssignmentKeys, now = new Date()) {
    const valid = new Set(normalizeActiveKeys(validAssignmentKeys));
    for (const remap of this.pendingRemaps || []) valid.add(remap.oldKey);
    return this.enqueue(async () => {
      const result = await this.storageArea.get(DAILY_RULE_USAGE_KEY);
      const raw = result[DAILY_RULE_USAGE_KEY];
      const state = normalizeDailyRuleUsageState(raw, now);
      for (const key of Object.keys(state.usageSeconds)) {
        if (!valid.has(key)) delete state.usageSeconds[key];
      }
      if (state.lastSample) {
        state.lastSample.assignmentKeys = state.lastSample.assignmentKeys.filter(key => valid.has(key));
      }
      if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(state)) {
        await this.storageArea.set({ [DAILY_RULE_USAGE_KEY]: state });
      }
      return state;
    });
  }
}
