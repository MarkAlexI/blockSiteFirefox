function dataAttributeName(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  get values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  add(...tokens) {
    const values = this.values;
    tokens.forEach(token => values.add(token));
    this.element.className = [...values].join(' ');
  }

  remove(...tokens) {
    const values = this.values;
    tokens.forEach(token => values.delete(token));
    this.element.className = [...values].join(' ');
  }

  contains(token) {
    return this.values.has(token);
  }

  toggle(token, force) {
    const enabled = force === undefined ? !this.contains(token) : Boolean(force);
    if (enabled) this.add(token);
    else this.remove(token);
    return enabled;
  }
}

function matchesSelector(element, selector) {
  if (element.nodeType !== 1) return false;

  let expression = selector.trim();
  const exclusions = [...expression.matchAll(/:not\(([^)]+)\)/g)];
  if (exclusions.some(match => matchesSelector(element, match[1]))) return false;
  expression = expression.replace(/:not\([^)]+\)/g, '');

  if (expression.includes(':checked')) {
    if (!element.checked) return false;
    expression = expression.replace(':checked', '');
  }

  const tag = expression.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && element.tagName !== tag.toUpperCase()) return false;

  for (const [, id] of expression.matchAll(/#([\w-]+)/g)) {
    if (element.id !== id) return false;
  }

  for (const [, className] of expression.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(className)) return false;
  }

  for (const [, name, quote, expected] of expression.matchAll(/\[([\w-]+)(?:=(['"]?)([^\]'"=]+)\2)?\]/g)) {
    const value = name.startsWith('data-')
      ? element.dataset[dataAttributeName(name)]
      : element.getAttribute(name) ?? element[name];
    if (value === undefined || value === null) return false;
    if (expected !== undefined && String(value) !== expected) return false;
  }

  return Boolean(expression);
}

function matchesSelectorChain(element, selector) {
  const parts = selector.trim().split(/\s+/);
  let current = element;

  if (!matchesSelector(current, parts.pop())) return false;

  while (parts.length > 0) {
    const part = parts.pop();
    current = current.parentNode;
    while (current && !matchesSelector(current, part)) current = current.parentNode;
    if (!current) return false;
  }

  return true;
}

export class FakeElement {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.nodeType = 1;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = {
      setProperty(name, value) {
        this[name] = String(value);
      }
    };
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.tabIndex = -1;
    this.id = '';
    this.name = '';
    this.type = '';
    this.parentNode = null;
    this.focusCount = 0;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.replaceChildren();
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    child.ownerDocument ||= this.ownerDocument;
    return child;
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name === 'id') this.id = normalized;
    if (name === 'class') this.className = normalized;
    if (name.startsWith('data-')) this.dataset[dataAttributeName(name)] = normalized;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  matches(selector) {
    return selector.split(',').some(part => matchesSelectorChain(this, part));
  }

  querySelectorAll(selector) {
    const expressions = selector.split(',').map(part => part.trim());
    const found = [];

    const visit = element => {
      for (const child of element.children || []) {
        if (expressions.some(expression => matchesSelectorChain(child, expression))) {
          found.push(child);
        }
        visit(child);
      }
    };

    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(value => value !== listener));
  }

  dispatchEvent(event) {
    const dispatched = {
      target: this,
      currentTarget: this,
      detail: 1,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...event,
      type: event.type
    };

    const handler = this[`on${dispatched.type}`];
    if (typeof handler === 'function') handler(dispatched);
    for (const listener of [...(this.listeners.get(dispatched.type) || [])]) listener(dispatched);
    return !dispatched.defaultPrevented;
  }

  async dispatch(type, details = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      detail: 1,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...details
    };
    const results = [];
    const handler = this[`on${type}`];
    if (typeof handler === 'function') results.push(handler(event));
    for (const listener of [...(this.listeners.get(type) || [])]) results.push(listener(event));
    await Promise.all(results);
    return event;
  }

  click() {
    return this.dispatch('click');
  }

  focus() {
    this.focusCount += 1;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.dispatchEvent({ type: 'focus' });
  }
}

export class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
    this.activeElement = null;
    this.title = '';
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createTextNode(textContent) {
    return { nodeType: 3, textContent: String(textContent), children: [], parentNode: null };
  }

  getElementById(id) {
    return this.documentElement.querySelector(`#${id}`);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener));
  }

  async dispatch(type, details = {}) {
    const event = {
      type,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...details
    };
    await Promise.all([...(this.listeners.get(type) || [])].map(listener => listener(event)));
    return event;
  }

  addElement(id, tagName = 'div', attributes = {}) {
    const element = this.createElement(tagName);
    element.id = id;
    Object.assign(element, attributes);
    this.body.appendChild(element);
    return element;
  }
}

function createStorageArea(initial = {}) {
  const data = structuredClone(initial);

  return {
    data,
    getError: null,
    setError: null,
    get(keys, callback) {
      if (this.getError) return Promise.reject(this.getError);
      const selected = keys == null
        ? Object.keys(data)
        : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys);
      const result = Object.fromEntries(selected
        .filter(key => key in data || (!Array.isArray(keys) && typeof keys === 'object'))
        .map(key => [key, structuredClone(data[key] ?? keys?.[key])]));
      if (typeof callback === 'function') callback(result);
      return Promise.resolve(result);
    },
    set(values, callback) {
      if (this.setError) return Promise.reject(this.setError);
      Object.assign(data, structuredClone(values));
      if (typeof callback === 'function') callback();
      return Promise.resolve();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
      if (typeof callback === 'function') callback();
      return Promise.resolve();
    }
  };
}

export function createExtensionApi({ sync = {}, local = {}, tabs = [], version = '5.1.7' } = {}) {
  const messages = [];
  const removedTabs = [];
  const createdTabs = [];
  const uninstallUrls = [];
  const storageListeners = [];

  return {
    messages,
    removedTabs,
    createdTabs,
    uninstallUrls,
    storage: {
      sync: createStorageArea(sync),
      local: createStorageArea(local),
      onChanged: {
        addListener(listener) { storageListeners.push(listener); },
        emit(changes, namespace) { storageListeners.forEach(listener => listener(changes, namespace)); }
      }
    },
    runtime: {
      id: 'test-extension-id',
      getURL(path) { return `extension://test-extension-id/${path}`; },
      getManifest() { return { version, manifest_version: 3 }; },
      setUninstallURL(url) { uninstallUrls.push(url); },
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        if (typeof callback === 'function') callback({ success: true });
        return Promise.resolve({ success: true });
      }
    },
    tabs: {
      values: tabs,
      query(_query, callback) {
        const result = structuredClone(this.values);
        if (typeof callback === 'function') callback(result);
        return Promise.resolve(result);
      },
      async remove(ids) { removedTabs.push(...(Array.isArray(ids) ? ids : [ids])); },
      async create(details) { createdTabs.push(details); return details; }
    },
    i18n: {
      getMessage(key, substitutions) {
        if (!substitutions?.length) return key;
        return `${key}:${substitutions.join(',')}`;
      },
      getUILanguage() { return 'en-US'; }
    }
  };
}

export async function withExtensionEnvironment(api, callback, { document = null, window = null } = {}) {
  const names = ['chrome', 'browser', 'document', 'window', 'DebugController'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

  globalThis.chrome = api;
  globalThis.browser = api;
  if (document) globalThis.document = document;
  if (window) globalThis.window = window;

  try {
    return await callback();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}
