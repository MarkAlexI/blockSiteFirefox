let isDebug = false;
let settingsRevision = 0;

function isSettingsObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getStoredSettings(result) {
  if (!isSettingsObject(result)) return null;
  if (result.settings === undefined) return {};
  return isSettingsObject(result.settings) ? result.settings : null;
}

async function initializeDebugMode() {
  const revision = settingsRevision;
  try {
    const settings = getStoredSettings(await browser.storage.sync.get(['settings']));
    // A delayed initial snapshot must not undo a newer storage change.
    if (revision === settingsRevision) isDebug = settings?.debugMode === true;
  } catch {
    // Logging remains available with debug disabled when the initial read fails.
  }
}

async function setDebugMode(debugMode) {
  try {
    const settings = getStoredSettings(await browser.storage.sync.get(['settings']));
    // A failed or malformed read must never replace unrelated saved settings.
    if (settings === null) return false;
    await browser.storage.sync.set({ settings: { ...settings, debugMode } });
    return true;
  } catch {
    return false;
  }
}

browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.settings) {
    settingsRevision += 1;
    const settings = changes.settings.newValue;
    isDebug = isSettingsObject(settings) && settings.debugMode === true;
    if (isDebug) {
      console.log('%c Debug Mode Enabled via Settings ', 'background: green; color: white;');
    }
  }
});

void initializeDebugMode();

const stringToColor = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00ffffff).toString(16).toUpperCase();
  return '#' + '00000'.substring(0, 6 - c.length) + c;
};

class Logger {
  constructor(context) {
    this.context = context;
    this.color = stringToColor(context);
    this.textColor = '#fff';
  }

  _format() {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    return [
      `%c ${this.context} %c [${timestamp}]`,
      `background: ${this.color}; color: ${this.textColor}; border-radius: 3px; font-weight: bold; padding: 2px 4px;`,
      `color: gray; font-size: 0.9em;`
    ];
  }

  log(...args) {
    if (!isDebug) return;
    const [prefix, s1, s2] = this._format();
    console.log(prefix, s1, s2, ...args);
  }

  info(...args) {
    if (!isDebug) return;
    const [prefix, s1, s2] = this._format();
    console.info(prefix, s1, s2, ...args);
  }

  warn(...args) {
    if (!isDebug) return;
    const [prefix, s1, s2] = this._format();
    console.warn(prefix, s1, s2, ...args);
  }

  error(...args) {
    const [prefix, s1, s2] = this._format();
    console.error(prefix, s1, s2, ...args);
  }

  group(label) {
    if (isDebug) console.group(label);
  }

  groupEnd() {
    if (isDebug) console.groupEnd();
  }
}

globalThis.DebugController = {
  enable: () => setDebugMode(true),
  disable: () => setDebugMode(false),
  status: () => isDebug
};

export default Logger;
