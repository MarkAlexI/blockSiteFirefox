export const DIAGNOSTIC_EVENTS_KEY = 'diagnosticEvents';
export const DIAGNOSTIC_STATE_KEY = 'diagnosticState';
export const MAX_DIAGNOSTIC_EVENTS = 100;

const REDACTED = '<redacted>';
const REDACTED_URL = '<redacted-url>';
const REDACTED_EMAIL = '<redacted-email>';
const REDACTED_LICENSE = '<redacted-license>';
const MAX_STRING_LENGTH = 400;
const MAX_DEPTH = 5;

const SENSITIVE_KEYS = new Set([
  'url',
  'urls',
  'blockurl',
  'redirecturl',
  'fromurl',
  'tourl',
  'domain',
  'domains',
  'email',
  'licensekey',
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'passwordhash',
  'secret',
  'authorization'
]);

function sanitizeString(value) {
  return value
    .replace(/(?:https?|file|chrome-extension|moz-extension):\/\/[^\s"'<>]+/gi, REDACTED_URL)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, REDACTED_EMAIL)
    .replace(/\bBD-[A-Z0-9-]{6,}\b/gi, REDACTED_LICENSE)
    .slice(0, MAX_STRING_LENGTH);
}

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase());
}

export function sanitizeDiagnosticValue(value, key = '', depth = 0) {
  if (isSensitiveKey(key)) return REDACTED;
  if (depth > MAX_DEPTH) return '<truncated>';
  if (value === null || value === undefined) return value ?? null;

  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);

  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name || 'Error'),
      message: sanitizeString(value.message || String(value)),
      code: value.code ? sanitizeString(String(value.code)) : undefined
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item =>
      sanitizeDiagnosticValue(item, '', depth + 1)
    );
  }

  if (typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) {
      const sanitized = sanitizeDiagnosticValue(childValue, childKey, depth + 1);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }

  return sanitizeString(String(value));
}

export function createDiagnosticStore({
  localStorage,
  getSettings,
  now = () => Date.now(),
  maxEvents = MAX_DIAGNOSTIC_EVENTS
}) {
  let mutationQueue = Promise.resolve();

  function enqueue(operation) {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.catch(() => {});
    return run;
  }

  async function getEvents() {
    const result = await localStorage.get([DIAGNOSTIC_EVENTS_KEY]);
    return Array.isArray(result[DIAGNOSTIC_EVENTS_KEY]) ?
      result[DIAGNOSTIC_EVENTS_KEY] : [];
  }

  async function getState() {
    const result = await localStorage.get([DIAGNOSTIC_STATE_KEY]);
    const value = result[DIAGNOSTIC_STATE_KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  async function recordEvent(level, source, code, details = {}) {
    return enqueue(async () => {
      const settings = await getSettings();
      if (!settings?.debugMode) return false;

      const events = await getEvents();
      events.push({
        timestamp: now(),
        level: sanitizeString(String(level || 'info')).toLowerCase(),
        source: sanitizeString(String(source || 'extension')),
        code: sanitizeString(String(code || 'unknown')),
        details: sanitizeDiagnosticValue(details)
      });

      await localStorage.set({
        [DIAGNOSTIC_EVENTS_KEY]: events.slice(-Math.max(1, maxEvents))
      });
      return true;
    });
  }

  async function updateState(patch) {
    return enqueue(async () => {
      const current = await getState();
      const next = {
        ...current,
        ...sanitizeDiagnosticValue(patch)
      };

      if (JSON.stringify(current) === JSON.stringify(next)) return current;
      await localStorage.set({ [DIAGNOSTIC_STATE_KEY]: next });
      return next;
    });
  }

  async function getSnapshot() {
    await mutationQueue;
    const [events, state] = await Promise.all([getEvents(), getState()]);
    return {
      events: sanitizeDiagnosticValue(events),
      state: sanitizeDiagnosticValue(state)
    };
  }

  async function clearEvents() {
    return enqueue(async () => {
      await localStorage.set({ [DIAGNOSTIC_EVENTS_KEY]: [] });
      return true;
    });
  }

  return {
    recordEvent,
    updateState,
    getSnapshot,
    clearEvents
  };
}
