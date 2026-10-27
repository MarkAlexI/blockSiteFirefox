export function collectReferencedLocaleKeys(content) {
  const keys = new Set();
  const patterns = [
    /\bdata-i18n(?:-(?:placeholder|aria-label))?\s*=\s*["']([^"']+)["']/gi,
    /\bt\(\s*["']([^"']+)["']/g,
    /getMessage\(\s*["']([^"']+)["']/g,
    /setContent\([^,]+,\s*["']([^"']+)["']/g,
    /setAttribute\(\s*["']data-i18n(?:-(?:placeholder|aria-label))?["']\s*,\s*["']([^"']+)["']/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      keys.add(match[1]);
    }
  }

  return keys;
}
