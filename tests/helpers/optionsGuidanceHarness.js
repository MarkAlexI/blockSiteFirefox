import fs from 'node:fs';
import vm from 'node:vm';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './extensionTestHarness.js';
import * as guidance from '../../options/userGuidance.js';

const { ProManager: TrustedProManager } = await withExtensionEnvironment(
  createExtensionApi(), () => import('../../pro/proManager.js')
);

// Evaluate the actual Options class and event callbacks, with unrelated managers
// stubbed. Every page gets its own DOM/realm; storage and the worker are shared.
const source = fs.readFileSync(new URL('../../options/options.js', import.meta.url), 'utf8');
const classStart = source.indexOf('class OptionsPage {');
const autoStart = source.indexOf('const optionsPage = new OptionsPage();');
const classSource = source.slice(classStart, autoStart);
const callbacks = source.slice(autoStart).replace('const optionsPage = new OptionsPage();', 'const optionsPage = testPage;');
let createController;
try { ({ createProGuidanceController: createController } = await import('../../options/proGuidanceController.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
export async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}
export const at = (day, hour = 9, month = 8, year = 2026) => new Date(year, month, day, hour).getTime();
export const priorState = (extra = {}) => ({ version: 1, tipIndex: 0,
  lastShownDay: '2026-09-29', dismissed: false, completed: false, ...extra });

export function createGuidanceHub({ state, isPro = true, installationDate = '2026-08-01T00:00:00Z', time = at(30) } = {}) {
  const data = state === undefined ? {} : { proGuidance: structuredClone(state) };
  let credentials = { isPro, installationDate, licenseKey: isPro ? 'test-key' : null };
  let clock = time;
  const pages = [];
  const listeners = new Set();
  const runtimeListeners = new Set();
  const readGates = [];
  const credentialGates = [];
  const writeGates = [];
  const writes = [];
  const requests = [];
  let tail = Promise.resolve();
  const access = value => ({ credentials: value, isPro: value.isPro === true,
    isLegacyUser: TrustedProManager.resolveLegacyAccess(value) });
  const delay = async (gates, result) => {
    const gate = gates.shift();
    if (gate) { gate.started.resolve(); await gate.release.promise; }
    return result;
  };
  const storage = {
    async get() { return delay(readGates, structuredClone(data)); },
    async set(values) {
      await delay(writeGates, null);
      for (const [key, newValue] of Object.entries(values)) {
        const oldValue = structuredClone(data[key]);
        data[key] = structuredClone(newValue);
        writes.push(structuredClone(values));
        for (const listener of [...listeners]) listener({ [key]: { oldValue, newValue: structuredClone(newValue) } }, 'local');
      }
    }
  };
  const getAccess = async () => delay(credentialGates, access(structuredClone(credentials)));
  const deps = { storage, getAccess, now: () => clock,
    runExclusive: task => { const result = tail.then(task, task); tail = result.catch(() => {}); return result; } };
  let controller = createController?.(deps);
  const send = async message => {
    requests.push(structuredClone(message));
    if (!controller) throw new Error('Guidance runtime controller not implemented');
    if (message.type === 'pro_guidance:preview') return { success: true, ...await controller.preview() };
    if (message.type === 'pro_guidance:shown') return { success: true, ...await controller.shown(message) };
    if (message.type === 'pro_guidance:dismiss') return { success: true, ...await controller.dismiss() };
    throw new Error('Unexpected runtime message: '+message.type);
  };
  const api = {
    storage: { local: storage, onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) } },
    runtime: { onMessage: { addListener: listener => runtimeListeners.add(listener) } }
  };
  const makeGate = gates => { const gate = { started: deferred(), release: deferred() }; gates.push(gate); return gate; };
  return {
    data, writes, requests, storage, api,
    pauseRead: () => makeGate(readGates), pauseAccess: () => makeGate(credentialGates),
    pauseWrite: () => makeGate(writeGates),
    setTime: value => { clock = value; },
    restartWorker: () => { controller = createController?.(deps); },
    async setCredentials(update) {
      const oldValue = structuredClone(credentials);
      credentials = { ...credentials, ...update };
      for (const listener of [...listeners]) listener({ credentials: { oldValue, newValue: structuredClone(credentials) } }, 'sync');
      await settle();
    },
    broadcastStatus(value) { for (const listener of [...runtimeListeners]) listener({ type: 'pro_status_changed', isPro: value }); },
    page({ hidden = false, listen = false } = {}) {
      const doc = new FakeDocument();
      doc.visibilityState = hidden ? 'hidden' : 'visible';
      doc.hidden = hidden;
      const wrapper = doc.addElement('starter-tips', 'aside', { className: 'hidden' });
      for (const [id, tag] of [['starter-tips-section','div'],['starter-tips-list','ul'],['pro-tips-section','div'],['pro-tips-list','ul'],['pro-tips-dismiss','button']]) {
        const el = doc.createElement(tag); el.id = id;
        if (id.endsWith('section')) el.className = 'hidden';
        wrapper.appendChild(el);
      }
      class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
      const proManager = { getAccess, initializeProFeatures: async () => {}, updateProFeaturesVisibility: () => {} };
      const context = vm.createContext({ document: doc, window: { addEventListener() {} }, chrome: api, browser: api,
        Date: ClockDate, console, ...guidance, ProManager: proManager, sendRuntimeMessage: send,
        t: key => key, logger: { info() {}, log() {}, error() {} }, initializeNoSpaceInputs() {},
        setTimeout, clearTimeout, queueMicrotask });
      vm.runInContext(classSource+'\nglobalThis.PageClass = OptionsPage;', context);
      const page = Object.create(context.PageClass.prototype);
      Object.assign(page, {
        logger: context.logger, isPro: access(credentials).isPro, isLegacyUser: access(credentials).isLegacyUser, profileRefreshId: 0,
        starterTips: wrapper, starterTipsSection: doc.getElementById('starter-tips-section'), starterTipsList: doc.getElementById('starter-tips-list'),
        proTipsSection: doc.getElementById('pro-tips-section'), proTipsList: doc.getElementById('pro-tips-list'),
        proTipsDismissButton: doc.getElementById('pro-tips-dismiss'),
        settingsManager: { initFocusSessionBanner: async () => {} }, rulesUI: { cleanup() {} },
        rulePacksUI: { initialize() {} }, diagnosticsUI: { initialize() {} }, telemetryUI: { initialize: async () => {} },
        initializeUI() {}, updateWhitelistButtonState() {}, exposeDebugTools() {},
        refreshProfileView: async () => {},
      });
      context.testPage = page;
      vm.runInContext(callbacks, context);
      if (listen) page.setupStorageListeners();
      pages.push(page);
      return { page, doc,
        tip: () => page.proTipsList.children.map(item => item.textContent),
        close: () => page.cleanup(),
        visible: () => !page.proTipsSection.classList.contains('hidden'),
        async visibility(value) {
          doc.visibilityState = value ? 'visible' : 'hidden'; doc.hidden = !value;
          await doc.dispatch('visibilitychange'); await settle();
        }
      };
    }
  };
}
