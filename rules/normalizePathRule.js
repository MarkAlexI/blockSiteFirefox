export function normalizePathRule(input) {
  try {
    const url = new URL(input);
    
    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '');
    
    return hostname + pathname;
  } catch(e) {
    return input;
  }
}