export function normalizePathRule(input) {
  try {
    if (typeof input !== 'string') return input;
    const urlString = /^https?:/i.test(input) ? input : `https://${decodeURIComponent(input)}`;
    const url = new URL(urlString);
    
    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '');
    
    return hostname + pathname;
  } catch (e) {
    return input;
  }
}
