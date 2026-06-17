export function isValidPathSegment(segment) {
  try {
    encodeURIComponent(segment);
    return true;
  }
  catch {
    return false;
  }
}