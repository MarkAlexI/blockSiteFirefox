import { createDnrUrlFilter, InvalidDnrUrlFilterError } from './dnrRuleFactory.js';
import { isProtectedRequestHostname } from '../utils/protectedDomains.js';

function normalizeFilter(blockURL) {
  try {
    return createDnrUrlFilter(blockURL).slice(2).toLowerCase();
  } catch (error) {
    if (!(error instanceof InvalidDnrUrlFilterError)) throw error;
    return '';
  }
}

const NON_SEPARATOR_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789_-.%';

function matchesPartAt(candidate, part, offset, allowEndSeparator = false) {
  if (offset < 0) return false;
  if (!part.includes('^')) return candidate.startsWith(part, offset);
  for (let index = 0; index < part.length; index++) {
    const actual = candidate[offset + index];
    if (part[index] === '^') {
      if (actual === undefined) {
        return allowEndSeparator && index === part.length - 1 && offset + index === candidate.length;
      }
      if (NON_SEPARATOR_CHARACTERS.includes(actual)) return false;
    } else if (part[index] !== actual) {
      return false;
    }
  }
  return true;
}

function findPart(candidate, part, from, allowEndSeparator = false) {
  if (!part.includes('^')) return candidate.indexOf(part, from);
  const extra = allowEndSeparator && part.endsWith('^') ? 1 : 0;
  for (let offset = from; offset + part.length <= candidate.length + extra; offset++) {
    if (matchesPartAt(candidate, part, offset, allowEndSeparator)) return offset;
  }
  return -1;
}

function matchesUrlFilter(candidate, filter) {
  let endAnchored = filter.endsWith('|');
  const pattern = endAnchored ? filter.slice(0, -1) : filter;
  // A final wildcard can consume the remaining URL, even before a final '|'.
  if (pattern.endsWith('*')) endAnchored = false;
  const parts = pattern.split('*').filter(Boolean);
  if (parts.length === 0) return !endAnchored;
  if (parts.length === 1) {
    const part = parts[0];
    return matchesPartAt(candidate, part, 0, true) && (!endAnchored ||
      candidate.length === part.length ||
      (part.endsWith('^') && candidate.length === part.length - 1));
  }
  if (!matchesPartAt(candidate, parts[0], 0)) return false;
  let offset = parts[0].length;
  // Find intermediate parts once, in order, without recursive backtracking.
  for (let index = 1; index < parts.length - 1; index++) {
    const found = findPart(candidate, parts[index], offset);
    if (found === -1) return false;
    offset = found + parts[index].length;
  }
  const tail = parts[parts.length - 1];
  if (!endAnchored) return findPart(candidate, tail, offset, true) !== -1;
  // The final part must be a suffix, not necessarily its first occurrence.
  // Only a final '^' can match zero characters at the URL's end.
  const end = candidate.length - tail.length;
  return (end >= offset && matchesPartAt(candidate, tail, end)) ||
    (tail.endsWith('^') && end + 1 >= offset && matchesPartAt(candidate, tail, end + 1, true));
}

function buildDomainAnchoredCandidates(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return [];
    const hostname = parsed.hostname.toLowerCase();
    if (isProtectedRequestHostname(hostname)) return [];
    const port = parsed.port ? `:${parsed.port}` : '';
    const tail = `${port}${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`.toLowerCase();
    const labels = hostname.split('.');
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
  return buildDomainAnchoredCandidates(url).some(candidate => matchesUrlFilter(candidate, filter));
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
