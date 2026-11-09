import { createDnrUrlFilter, InvalidDnrUrlFilterError } from './dnrRuleFactory.js';
import { isProtectedRequestHostname } from '../utils/protectedDomains.js';

function normalizeFilter(blockURL) {
  try {
    return createDnrUrlFilter(String(blockURL || '').trim()).slice(2).toLowerCase();
  } catch (error) {
    if (!(error instanceof InvalidDnrUrlFilterError)) throw error;
    return '';
  }
}

function matchesWildcardPrefix(candidate, filter) {
  // Keep the existing behavior for separator/end-anchor expressions. Expanding
  // only '*' in those expressions could introduce false-positive matches.
  if (filter.includes('^') || filter.endsWith('|')) return candidate.startsWith(filter);
  const parts = filter.split('*');
  if (!candidate.startsWith(parts[0])) return false;
  let offset = parts[0].length;
  // Literal segments advance monotonically; no user-controlled regular
  // expression or recursive wildcard backtracking runs in the worker.
  for (let index = 1; index < parts.length; index++) {
    const next = candidate.indexOf(parts[index], offset);
    if (next === -1) return false;
    offset = next + parts[index].length;
  }
  return true;
}

function buildDomainAnchoredCandidates(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return [];
    const hostname = parsed.hostname.toLowerCase();
    if (isProtectedRequestHostname(hostname)) return [];
    const port = parsed.port ? `:${parsed.port}` : '';
    const tail = `${port}${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`.toLowerCase();
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
  return buildDomainAnchoredCandidates(url).some(candidate => matchesWildcardPrefix(candidate, filter));
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
