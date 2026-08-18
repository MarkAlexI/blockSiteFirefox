export const BUILD_ID = 'RC12';

export function getTelemetryExtensionVersion(manifest = {}, build = BUILD_ID) {
  const version = String(manifest?.version || 'unknown').trim();
  const normalizedBuild = String(build || '').trim();
  if (/^RC\d+$/i.test(normalizedBuild) && version !== 'unknown') {
    return `${version}-${normalizedBuild.toLowerCase()}`;
  }
  return version || 'unknown';
}
