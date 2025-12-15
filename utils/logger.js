const IS_DEBUG = false;

const Logger = {
  log: (...args) => {
    if (IS_DEBUG) {
      console.log(...args);
    }
  },
  
  info: (...args) => {
    if (IS_DEBUG) {
      console.info(...args);
    }
  },
  
  warn: (...args) => {
    if (IS_DEBUG) {
      console.warn(...args);
    }
  },
  
  error: (...args) => {
    console.error(...args);
  },
  
  group: (label) => {
    if (IS_DEBUG) console.group(label);
  },
  
  groupEnd: () => {
    if (IS_DEBUG) console.groupEnd();
  }
};

export default Logger;