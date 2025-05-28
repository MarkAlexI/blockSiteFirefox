function normalizeUrlFilter(input) {
  try {
    const url = new URL(input);
    return url.hostname.replace(/^www\./, '');
  } catch (e) {
    return input;
  }
}