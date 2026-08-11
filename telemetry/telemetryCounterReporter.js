import { normalizeCounterName } from './telemetrySanitizer.js';

export function recordTelemetryCounter(name, {
  runtimeApi = globalThis.browser?.runtime
} = {}) {
  const safeName = normalizeCounterName(name);
  if (!safeName || !runtimeApi?.sendMessage) return false;

  try {
    const result = runtimeApi.sendMessage({
      type: 'telemetry:incrementCounter',
      name: safeName
    });

    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }

    return true;
  } catch {
    // Telemetry must never interfere with the extension page itself.
    return false;
  }
}
