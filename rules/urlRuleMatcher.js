import { normalizePathRule } from './normalizePathRule.js';
import { isProtectedRequestHostname } from '../utils/protectedDomains.js';

function normalizeFilter(blockURL) {
  return normalizePathRule(String(blockURL || '').trim()).toLowerCase();
}

function buildDomainAnchoredCandidates(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (isProtectedRequestHostname(hostname)) return [];
    const tail = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`.toLowerCase();
    const labels = hostname.split('.').filter(Boolean);
    const candidates = [];
    for (let index = 0; index < labels.length; index++) {
      candidates.push(`${labels.slice(index).join('.')}${tail}`);
    }
    return candidates;
  } catch {
    return [];
  }
}

/**
 * Mirrors the extension's DNR `||${filter}` matching contract closely enough
 * for foreground usage attribution and tab-closing decisions. The filter is
 * anchored at a domain-label boundary, but it may be a partial domain label
 * such as `yout`, so `m.youtube.com` is a valid match.
 */
export function doesUrlMatchBlockRule(url, blockURL) {
  const filter = normalizeFilter(blockURL);
  if (!filter || !url) return false;
  return buildDomainAnchoredCandidates(url).some(candidate => candidate.startsWith(filter));
}

export function findBestMatchingRule(url, rules) {
  if (!Array.isArray(rules)) return null;
  let best = null;
  let bestLength = -1;

  for (const rule of rules) {
    if (!doesUrlMatchBlockRule(url, rule?.blockURL)) continue;
    const length = normalizeFilter(rule?.blockURL).length;
    if (length > bestLength) {
      best = rule;
      bestLength = length;
    }
  }

  return best;
}
