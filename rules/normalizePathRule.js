export function normalizePathRule(input) {
  try {
    if (typeof input !== 'string') return input;
    // Let URL serialize the path; decoding first turns %2F, %3F and %23
    // into structural separators and can change the target being blocked.
    const urlString = /^https?:/i.test(input) ? input : `https://${input}`;
    const url = new URL(urlString);
    
    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '');
    
    return hostname + pathname;
  } catch (e) {
    return input;
  }
}
