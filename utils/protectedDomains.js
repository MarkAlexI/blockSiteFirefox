const PROTECTED_REQUEST_DOMAINS = Object.freeze([
  'accounts.google.com',
  'accounts.youtube.com',
  'addons.mozilla.org',
  'blockdistraction.com',
  'ext.pp.ua',
  'markdigital.cc',
  'markdigital.com'
]);

export function getProtectedRequestDomains() {
  return PROTECTED_REQUEST_DOMAINS;
}

export function isProtectedRequestHostname(hostname) {
  const normalized = typeof hostname === 'string'
    ? hostname.trim().toLowerCase()
    : '';

  return normalized !== '' && PROTECTED_REQUEST_DOMAINS.some(domain =>
    normalized === domain || normalized.endsWith(`.${domain}`)
  );
}
