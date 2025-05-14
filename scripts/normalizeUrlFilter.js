function normalizeUrlFilter(input) {
  try {
    const url = new URL(input);
    return url.hostname + url.pathname;
  } catch (e) {
    return input;
  }
}