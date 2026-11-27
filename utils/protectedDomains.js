const PROTECTED_REQUEST_DOMAINS = Object.freeze([
  'accounts.google.com',
  'accounts.youtube.com',
  'addons.mozilla.org',
  'blockdistraction.com',
  'ext.pp.ua',
  'markdigital.cc'
]);

// DNR preserves a domain's final DNS root dot when checking exclusions.
const PROTECTED_DOMAIN_VARIANTS = Object.freeze(
  PROTECTED_REQUEST_DOMAINS.flatMap(domain => [domain, `${domain}.`])
);

export function getProtectedRequestDomains() {
  return PROTECTED_DOMAIN_VARIANTS;
}

export function isProtectedRequestHostname(hostname) {
  const normalized = typeof hostname === 'string'
    ? hostname.trim().toLowerCase()
    : '';

  return normalized !== '' && PROTECTED_DOMAIN_VARIANTS.some(domain =>
    normalized === domain || normalized.endsWith(`.${domain}`)
  );
}
