import { WORKER_ERROR_MODULES, sanitizeErrorLocation } from './errorLocation.js';

// Only exact URLs for the fixed own-source catalog can produce a location.
// Filenames, extension IDs, messages and stacks never enter telemetry.
export function installWorkerErrorReporting({
  globalRef = globalThis, runtime, recordError, logger = console
}) {
  if (typeof globalRef.addEventListener !== 'function') return () => {};
  const modules = new Map(Object.entries(WORKER_ERROR_MODULES)
    .map(([file, module]) => [runtime.getURL(file), module]));
  const read = (object, key) => { try { return object?.[key]; } catch { return undefined; } };
  const name = error => read(error, 'name') || 'Error';
  const record = error => {
    void Promise.resolve().then(() => recordError(error)).catch(reportingError => {
      try { logger.info('Global worker error could not be recorded:', reportingError); }
      catch { /* Reporting must not create another global failure. */ }
    });
  };
  const onError = event => {
    const location = sanitizeErrorLocation({ module: modules.get(read(event, 'filename')), line: read(event, 'lineno') });
    record({ source: 'worker', code: 'uncaught_error', operation: 'service_worker',
      errorName: name(read(event, 'error')), ...(location ? { location } : {}) });
  };
  const onRejection = event => record({ source: 'worker', code: 'unhandled_rejection',
    operation: 'service_worker', errorName: name(read(event, 'reason')) });
  globalRef.addEventListener('error', onError);
  globalRef.addEventListener('unhandledrejection', onRejection);
  return () => {
    globalRef.removeEventListener?.('error', onError);
    globalRef.removeEventListener?.('unhandledrejection', onRejection);
  };
}
