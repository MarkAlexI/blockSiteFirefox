let isDebug = false;

browser.storage.sync.get(['settings'], (result) => {
  if (result.settings && result.settings.debugMode) {
    isDebug = true;
  }
});

browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.settings) {
    const newSettings = changes.settings.newValue;
    if (newSettings && typeof newSettings.debugMode !== 'undefined') {
      isDebug = newSettings.debugMode;
      if (isDebug) {
        console.log('%c Debug Mode Enabled via Settings ', 'background: green; color: white;');
      }
    }
  }
});

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
  enable: () => {
    browser.storage.sync.get(['settings'], (result) => {
      const settings = result.settings || {};
      settings.debugMode = true;
      browser.storage.sync.set({ settings });
    });
  },
  disable: () => {
    browser.storage.sync.get(['settings'], (result) => {
      const settings = result.settings || {};
      settings.debugMode = false;
      browser.storage.sync.set({ settings });
    });
  },
  status: () => isDebug
};

export default Logger;
