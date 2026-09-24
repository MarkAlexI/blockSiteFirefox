const DAY_MS = 24 * 60 * 60 * 1000;

export const STARTER_TIP_KEYS_BY_DAY = Object.freeze([
  Object.freeze(['mobilecopylinkhint', 'redirecturlhint']),
  Object.freeze(['strictmodedesc', 'focussessioninfo'])
]);

export function getStarterTipKeys(installationDate, now = Date.now()) {
  const installedAt = Date.parse(installationDate);
  const currentTime = Number(now);

  if (!Number.isFinite(installedAt) || !Number.isFinite(currentTime)) return [];

  const age = currentTime - installedAt;
  if (age < 0 || age >= STARTER_TIP_KEYS_BY_DAY.length * DAY_MS) return [];

  return [...STARTER_TIP_KEYS_BY_DAY[Math.floor(age / DAY_MS)]];
}

export function getStarterTipText(key, translate) {
  if (key === 'redirecturlhint') {
    return `${translate('redirecturlheader')}: ${translate(key)}`;
  }

  return translate(key);
}
