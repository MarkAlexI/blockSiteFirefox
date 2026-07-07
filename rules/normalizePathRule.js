export function normalizePathRule(input) {
  try {
    const urlString = input.startsWith('http') ? input : `https://${decodeURIComponent(input)}`;
    const url = new URL(urlString);
    
    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '');
    
    return hostname + pathname;
  } catch (e) {
    return input;
  }
}