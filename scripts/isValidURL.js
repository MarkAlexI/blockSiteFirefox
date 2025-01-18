export function isValidURL(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}