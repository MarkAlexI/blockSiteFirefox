const REASONS = new Set([
  'install', 'update', 'chrome_update', 'browser_update', 'shared_module_update'
]);

const PHASES = new Set([
  'prepare', 'initialize', 'permissions', 'dnr_integrity', 'open_install_page'
]);

const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'SecurityError',
  'NotAllowedError', 'InvalidStateError', 'NotSupportedError', 'QuotaExceededError',
  'NetworkError', 'UnknownError'
]);

// Track only fixed lifecycle phases. Error messages, URLs, keys and stacks never
// enter either the telemetry payload or this local diagnostic event.
export function createInstalledEventBoundary({
  recordError,
  recordDiagnostic = async () => {},
  logger = console
} = {}) {
  if (typeof recordError !== 'function' || typeof recordDiagnostic !== 'function') {
    throw new TypeError('Installed event boundary requires error recorders');
  }

  return async function runInstalledEvent(reason, handler) {
    const operation = REASONS.has(reason) ? reason : 'unknown';
    let phase = 'prepare';
    const completedPhases = [];

    const step = async (nextPhase, task) => {
      if (!PHASES.has(nextPhase) || typeof task !== 'function') {
        throw new TypeError('Unsupported installed event step');
      }
      phase = nextPhase;
      const result = await task();
      completedPhases.push(phase);
      return result;
    };

    try {
      return await handler(step);
    } catch (error) {
      const errorName = ERROR_NAMES.has(error?.name) ? error.name : 'Error';
      const code = `lifecycle_${phase}_failed`;
      logger.error(`Extension lifecycle failed (${operation}/${phase}):`, error);

      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => recordError({
          source: 'worker', code, operation, errorName
        })),
        Promise.resolve().then(() => recordDiagnostic({
          code, reason: operation, phase, errorName, completedPhases: [...completedPhases]
        }))
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          logger.info('Extension lifecycle failure could not be recorded:', outcome.reason);
        }
      }
      return undefined;
    }
  };
}
