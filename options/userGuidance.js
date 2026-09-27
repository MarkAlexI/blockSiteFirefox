const DAY_MS = 24 * 60 * 60 * 1000;

export const PRO_GUIDANCE_STORAGE_KEY = 'proGuidance';
export const PRO_GUIDANCE_VERSION = 1;

export const PRO_TIP_KEYS = Object.freeze([
  'protip_backup_transfer',
  'protip_blocking_modes',
  'protip_rule_lists',
  'protip_category_pause',
  'protip_rule_protection',
  'protip_focus_session',
  'protip_rule_packs',
  'protip_statistics'
]);

export const STARTER_TIP_KEYS_BY_DAY = Object.freeze([
  Object.freeze(['mobilecopylinkhint', 'redirecturlhint']),
  Object.freeze(['strictmodedesc', 'focussessioninfo']),
  Object.freeze(['startertip_path_rule', 'startertip_pause_rule'])
]);

const STARTER_TIP_TITLE_KEYS = Object.freeze({
  redirecturlhint: 'redirecturlheader',
  strictmodedesc: 'strictmodetitle',
  focussessioninfo: 'focussessionheader'
});

export function getStarterTipKeys(installationDate, now = Date.now()) {
  const installedAt = Date.parse(installationDate);
  const currentTime = Number(now);

  if (!Number.isFinite(installedAt) || !Number.isFinite(currentTime)) return [];

  const age = currentTime - installedAt;
  if (age < 0 || age >= STARTER_TIP_KEYS_BY_DAY.length * DAY_MS) return [];

  return [...STARTER_TIP_KEYS_BY_DAY[Math.floor(age / DAY_MS)]];
}

export function getStarterTipText(key, translate) {
  const titleKey = STARTER_TIP_TITLE_KEYS[key];
  if (titleKey) return `${translate(titleKey)}: ${translate(key)}`;

  return translate(key);
}

function getLocalDayKey(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeProGuidanceState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  if (state.version !== PRO_GUIDANCE_VERSION) return null;
  if (!Number.isInteger(state.tipIndex) || state.tipIndex < 0 || state.tipIndex >= PRO_TIP_KEYS.length) {
    return null;
  }
  if (typeof state.lastShownDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.lastShownDay)) {
    return null;
  }

  return {
    version: PRO_GUIDANCE_VERSION,
    tipIndex: state.tipIndex,
    lastShownDay: state.lastShownDay,
    dismissed: state.dismissed === true,
    completed: state.completed === true
  };
}

export function resolveProGuidance(state, now = Date.now()) {
  const today = getLocalDayKey(now);
  if (!today) return { tipKey: null, state: null, changed: false };

  const current = normalizeProGuidanceState(state);
  if (!current) {
    const initialState = {
      version: PRO_GUIDANCE_VERSION,
      tipIndex: 0,
      lastShownDay: today,
      dismissed: false,
      completed: false
    };
    return { tipKey: PRO_TIP_KEYS[0], state: initialState, changed: true };
  }

  if (current.dismissed || current.completed) {
    return { tipKey: null, state: current, changed: false };
  }

  if (today > current.lastShownDay) {
    const nextIndex = current.tipIndex + 1;
    const nextState = {
      ...current,
      tipIndex: Math.min(nextIndex, PRO_TIP_KEYS.length - 1),
      lastShownDay: today,
      completed: nextIndex >= PRO_TIP_KEYS.length
    };
    return {
      tipKey: nextState.completed ? null : PRO_TIP_KEYS[nextState.tipIndex],
      state: nextState,
      changed: true
    };
  }

  return { tipKey: PRO_TIP_KEYS[current.tipIndex], state: current, changed: false };
}

export function dismissProGuidance(state, now = Date.now()) {
  const resolved = resolveProGuidance(state, now);
  const current = resolved.state;
  if (!current) return null;

  return {
    ...current,
    dismissed: true
  };
}
