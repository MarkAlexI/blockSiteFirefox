import { normalizePathRule } from './normalizePathRule.js';

function parseRulePattern(blockURL) {
  const normalized = normalizePathRule(String(blockURL || '').trim()).toLowerCase();
  if (!normalized) return null;
  const slashIndex = normalized.indexOf('/');
  return {
    normalized,
    hostname: slashIndex === -1 ? normalized : normalized.slice(0, slashIndex),
    path: slashIndex === -1 ? '' : normalized.slice(slashIndex)
  };
}

export function doesUrlMatchBlockRule(url, blockURL) {
  const pattern = parseRulePattern(blockURL);
  if (!pattern || !url) return false;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = (parsed.pathname || '/').toLowerCase();
    const hostMatches = hostname === pattern.hostname || hostname.endsWith(`.${pattern.hostname}`);
    if (!hostMatches) return false;
    if (!pattern.path) return true;
    return pathname.startsWith(pattern.path);
  } catch {
    return false;
  }
}

export function findBestMatchingRule(url, rules) {
  if (!Array.isArray(rules)) return null;
  let best = null;
  let bestLength = -1;

  for (const rule of rules) {
    if (!doesUrlMatchBlockRule(url, rule?.blockURL)) continue;
    const length = normalizePathRule(String(rule.blockURL || '').trim()).length;
    if (length > bestLength) {
      best = rule;
      bestLength = length;
    }
  }

  return best;
}
