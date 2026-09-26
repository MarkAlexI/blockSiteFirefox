const DAY_MS = 24 * 60 * 60 * 1000;

export const STARTER_TIP_KEYS_BY_DAY = Object.freeze([
  Object.freeze(['mobilecopylinkhint', 'redirecturlhint']),
  Object.freeze(['strictmodedesc', 'focussessioninfo'])
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
