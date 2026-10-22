import { DialogTestDocument } from './helpers/dialogTestDocument.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_STATE_KEY,
  FEEDBACK_INITIAL_DELAY_MS,
  FEEDBACK_REPEAT_DELAY_MS,
  FEEDBACK_MAX_PROMPTS,
  FEEDBACK_MIN_ACTIVE_DAYS,
  FEEDBACK_MIN_FOCUS_SESSIONS,
  FEEDBACK_MIN_HANDLED_REQUESTS,
  countFeedbackUsageDays,
  hasMeaningfulFeedbackUsage,
  shouldShowFeedbackPrompt,
  createFeedbackPromptController,
  initFeedbackPrompt
} from '../feedback/feedbackPrompt.js';

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const result = {};
      for (const key of keys) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    }
  };
}

function createUsageHistory(entries = [
  { blocked: 7 },
  { blocked: 7 },
  { blocked: 6 }
]) {
  return Object.fromEntries(entries.map((entry, index) => [
    `2026-08-${String(index + 1).padStart(2, '0')}`,
    { blocked: 0, redirected: 0, focusSessions: 0, ...entry }
  ]));
}

function createEligibleStatistics() {
  return {
    totalBlocked: FEEDBACK_MIN_HANDLED_REQUESTS,
    dailyHistory: createUsageHistory()
  };
}

test('feedback prompt requires established local usage on multiple days', () => {
  assert.equal(hasMeaningfulFeedbackUsage({ rules: [{}, {}] }), false);
  assert.equal(hasMeaningfulFeedbackUsage({
    statistics: {
      totalBlocked: FEEDBACK_MIN_HANDLED_REQUESTS,
      dailyHistory: createUsageHistory([{ blocked: FEEDBACK_MIN_HANDLED_REQUESTS }])
    }
  }), false);
  assert.equal(hasMeaningfulFeedbackUsage({
    statistics: {
      totalBlocked: FEEDBACK_MIN_HANDLED_REQUESTS - 1,
      dailyHistory: createUsageHistory()
    }
  }), false);
  assert.equal(hasMeaningfulFeedbackUsage({
    statistics: createEligibleStatistics()
  }), true);
  assert.equal(hasMeaningfulFeedbackUsage({
    statistics: {
      successfulFocusSessions: FEEDBACK_MIN_FOCUS_SESSIONS,
      dailyHistory: createUsageHistory([
        { focusSessions: 1 },
        { focusSessions: 1 },
        { focusSessions: 1 }
      ])
    }
  }), true);
  assert.equal(countFeedbackUsageDays({
    dailyHistory: {
      first: { blocked: 1 },
      second: { redirected: 1 },
      empty: { blocked: 0 },
      invalid: null
    }
  }), 2);
  assert.equal(FEEDBACK_MIN_ACTIVE_DAYS, 3);
});

test('feedback prompt waits fourteen days even for an established user', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate: new Date(now - FEEDBACK_INITIAL_DELAY_MS + 1).toISOString(),
    state: {},
    statistics: createEligibleStatistics()
  }), false);

  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate: new Date(now - FEEDBACK_INITIAL_DELAY_MS).toISOString(),
    state: {},
    statistics: createEligibleStatistics()
  }), true);
});

test('feedback prompt allows three attempts separated by twenty-one days', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const installationDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate,
    state: {
      promptCount: 1,
      lastPromptedAt: now - FEEDBACK_REPEAT_DELAY_MS + 1
    },
    statistics: createEligibleStatistics()
  }), false);
  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate,
    state: {
      promptCount: 1,
      lastPromptedAt: now - FEEDBACK_REPEAT_DELAY_MS
    },
    statistics: createEligibleStatistics()
  }), true);
  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate,
    state: {
      promptCount: 2,
      lastPromptedAt: now - FEEDBACK_REPEAT_DELAY_MS
    },
    statistics: createEligibleStatistics()
  }), true);
  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate,
    state: { promptCount: FEEDBACK_MAX_PROMPTS, lastPromptedAt: 0 },
    statistics: createEligibleStatistics()
  }), false);
  assert.equal(FEEDBACK_MAX_PROMPTS, 3);
});

test('completed feedback state never prompts again', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate: '2026-01-01T00:00:00Z',
    state: { completed: true },
    statistics: createEligibleStatistics()
  }), false);
});

test('legacy feedback completion is migrated from sync storage', async () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const localStorage = createStorage({
    statistics: createEligibleStatistics()
  });
  const syncStorage = createStorage({
    credentials: { installationDate: '2026-01-01T00:00:00Z' },
    ui_prefs: {
      feedback: {
        completed: true,
        last_prompted: now - 1000
      }
    }
  });

  const controller = createFeedbackPromptController({
    localStorage,
    syncStorage,
    tabsApi: { async create() {} },
    now: () => now
  });

  const result = await controller.evaluate();
  assert.equal(result.shouldShow, false);
  assert.equal(localStorage.data[FEEDBACK_STATE_KEY].completed, true);
  assert.equal(localStorage.data[FEEDBACK_STATE_KEY].promptCount, 1);
});

test('review and support actions complete the prompt and open the correct Firefox destinations', async () => {
  const localStorage = createStorage();
  const syncStorage = createStorage();
  const opened = [];
  const tabsApi = {
    async create(details) {
      opened.push(details.url);
    }
  };
  const controller = createFeedbackPromptController({
    localStorage,
    syncStorage,
    tabsApi,
    reviewUrl: 'https://addons.mozilla.org/en-US/firefox/addon/blockersite/reviews/',
    supportUrl: 'https://support.example/'
  });

  let state = await controller.markShown({});
  assert.equal(state.promptCount, 1);

  state = await controller.openReview(state);
  assert.equal(state.completed, true);
  assert.equal(state.lastAction, 'review');
  assert.deepEqual(opened, [
    'https://addons.mozilla.org/en-US/firefox/addon/blockersite/reviews/'
  ]);

  const secondStorage = createStorage();
  const second = createFeedbackPromptController({
    localStorage: secondStorage,
    syncStorage,
    tabsApi,
    reviewUrl: 'https://addons.mozilla.org/en-US/firefox/addon/blockersite/reviews/',
    supportUrl: 'https://support.example/'
  });
  let secondState = await second.markShown({});
  secondState = await second.openSupport(secondState);
  assert.equal(secondState.completed, true);
  assert.equal(secondState.lastAction, 'support');
  assert.deepEqual(opened, [
    'https://addons.mozilla.org/en-US/firefox/addon/blockersite/reviews/',
    'https://support.example/'
  ]);
});


function createFeedbackDocument() {
  const document = new DialogTestDocument();
  document.elements = {};
  for (const [id, tag] of Object.entries({
    'feedback-dialog': 'dialog', 'feedback-close-btn': 'button',
    'feedback-review-btn': 'button', 'feedback-support-btn': 'button',
    'feedback-store-label': 'span', 'feedback-error': 'p', 'options-link': 'button'
  })) {
    const element = document.addElement(id, tag);
    document.elements[id] = element;
    element.emit = (type, event) => element.dispatch(type, event);
  }
  const dialog = document.elements['feedback-dialog'];
  for (const [id, element] of Object.entries(document.elements)) {
    if (id !== 'feedback-dialog' && id !== 'options-link') dialog.appendChild(element);
  }
  document.elements['options-link'].focus();
  return document;
}

function createEligibleFeedbackStorage() {
  return {
    localStorage: createStorage({ statistics: createEligibleStatistics() }),
    syncStorage: createStorage({
      credentials: { installationDate: '2026-01-01T00:00:00Z' }
    })
  };
}

test('feedback prompt reports display and AMO review click counters at the actual UI actions', async () => {
  const documentRef = createFeedbackDocument();
  const { localStorage, syncStorage } = createEligibleFeedbackStorage();
  const counters = [];
  const opened = [];
  const reviewUrl = 'https://addons.mozilla.org/en-US/firefox/addon/blockersite/reviews/';

  const shown = await initFeedbackPrompt({
    documentRef,
    localStorage,
    syncStorage,
    tabsApi: { async create(details) { opened.push(details.url); } },
    now: () => Date.parse('2026-08-11T08:00:00Z'),
    reviewUrl,
    recordCounter: name => counters.push(name)
  });

  assert.equal(shown, true);
  assert.equal(documentRef.elements['feedback-dialog'].open, true);
  assert.deepEqual(counters, ['feedback_prompt_shown']);

  await documentRef.elements['feedback-review-btn'].emit('click');

  assert.deepEqual(counters, [
    'feedback_prompt_shown',
    'feedback_review_clicked'
  ]);
  assert.deepEqual(opened, [reviewUrl]);
  assert.equal(localStorage.data[FEEDBACK_STATE_KEY].completed, true);
  assert.equal(localStorage.data[FEEDBACK_STATE_KEY].lastAction, 'review');
});

test('feedback prompt reports support clicks and dismissals without duplicate final actions', async () => {
  const supportDocument = createFeedbackDocument();
  const supportStorage = createEligibleFeedbackStorage();
  const supportCounters = [];

  await initFeedbackPrompt({
    documentRef: supportDocument,
    ...supportStorage,
    tabsApi: { async create() {} },
    now: () => Date.parse('2026-08-11T08:00:00Z'),
    reviewUrl: 'https://addons.mozilla.org/en-US/firefox/addon/blockersite/reviews/',
    recordCounter: name => supportCounters.push(name)
  });
  await supportDocument.elements['feedback-support-btn'].emit('click');

  assert.deepEqual(supportCounters, [
    'feedback_prompt_shown',
    'feedback_support_clicked'
  ]);

  const dismissDocument = createFeedbackDocument();
  const dismissStorage = createEligibleFeedbackStorage();
  const dismissCounters = [];

  await initFeedbackPrompt({
    documentRef: dismissDocument,
    ...dismissStorage,
    tabsApi: { async create() {} },
    now: () => Date.parse('2026-08-11T08:00:00Z'),
    reviewUrl: 'https://addons.mozilla.org/en-US/firefox/addon/blockersite/reviews/',
    recordCounter: name => dismissCounters.push(name)
  });

  await dismissDocument.elements['feedback-close-btn'].emit('click');
  await new Promise(resolve => setImmediate(resolve));
  await dismissDocument.elements['feedback-dialog'].emit('cancel', {
    preventDefault() {}
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(dismissCounters, [
    'feedback_prompt_shown',
    'feedback_dismissed'
  ]);
  assert.equal(dismissStorage.localStorage.data[FEEDBACK_STATE_KEY].lastAction, 'dismissed');
  assert.equal(dismissDocument.elements['feedback-dialog'].closeCount, 1);
});

async function openEligiblePrompt(documentRef, overrides = {}) {
  const storage = createEligibleFeedbackStorage();
  const options = { documentRef, ...storage, tabsApi: { async create() {} },
    now: () => Date.parse('2026-08-11T08:00:00Z'),
    reviewUrl: 'https://store.example/reviews',
    recordCounter() {}, ...overrides };
  const shown = await initFeedbackPrompt(options);
  return { shown, ...storage, options };
}

test('Feedback dismisses and returns focus before a slow storage write finishes', async () => {
  const document = createFeedbackDocument();
  const h = await openEligiblePrompt(document);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const set = h.localStorage.set.bind(h.localStorage);
  h.localStorage.set = async data => { await gate; return set(data); };
  assert.equal(document.activeElement.id, 'feedback-close-btn');
  const closing = document.elements['feedback-close-btn'].emit('click');
  assert.equal(document.elements['feedback-dialog'].open, false);
  assert.equal(document.activeElement.id, 'options-link');
  release(); await closing;
  assert.equal(h.localStorage.data[FEEDBACK_STATE_KEY].lastAction, 'dismissed');
});

test('Feedback can retry a failed page opening and keeps Cancel available throughout', async () => {
  const document = createFeedbackDocument();
  const previousChrome = globalThis.chrome;
  const previousBrowser = globalThis.browser;
  globalThis.browser = globalThis.chrome = { i18n: { getMessage: key => key } };
  try {
    let attempts = 0;
    const h = await openEligiblePrompt(document, { tabsApi: { async create() {
      if (++attempts === 1) throw new Error('private API details');
    } } });
    await document.elements['feedback-review-btn'].emit('click');
    assert.equal(document.elements['feedback-dialog'].open, true);
    assert.equal(document.elements['feedback-error'].textContent, 'feedback_action_error');
    assert.equal(document.elements['feedback-review-btn'].disabled, false);
    assert.equal(document.activeElement.id, 'feedback-close-btn');
    await document.elements['feedback-review-btn'].emit('click');
    assert.equal(attempts, 2);
    assert.equal(document.elements['feedback-dialog'].open, false);
    assert.equal(h.localStorage.data[FEEDBACK_STATE_KEY].completed, true);
  } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
});

test('cancelling pending Feedback does not overwrite completion, repeat the action or steal late focus', async () => {
  const document = createFeedbackDocument();
  const h = await openEligiblePrompt(document);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const set = h.localStorage.set.bind(h.localStorage);
  const writes = [];
  h.localStorage.set = async data => { writes.push(data); await gate; return set(data); };
  let opened = 0;
  h.options.tabsApi.create = async () => { opened++; };
  document.elements['feedback-review-btn'].focus();
  const action = document.elements['feedback-review-btn'].emit('click');
  await document.elements['feedback-support-btn'].emit('click');
  assert.equal(document.activeElement.id, 'feedback-close-btn');
  await document.elements['feedback-dialog'].emit('cancel');
  assert.equal(document.elements['feedback-dialog'].open, false);
  const other = document.addElement('next-action', 'button'); other.focus();
  release(); await action;
  assert.equal(writes.length, 1);
  assert.equal(opened, 1);
  assert.equal(h.localStorage.data[FEEDBACK_STATE_KEY].lastAction, 'review');
  assert.equal(h.localStorage.data[FEEDBACK_STATE_KEY].completed, true);
  assert.equal(document.activeElement.id, 'next-action');
});

test('concurrent Feedback initialization installs only one set of listeners and one shown counter', async () => {
  const document = createFeedbackDocument();
  const counters = [];
  const first = openEligiblePrompt(document, { recordCounter: name => counters.push(name) });
  const second = await openEligiblePrompt(document, { recordCounter: name => counters.push(name) });
  const result = await first;
  assert.equal(result.shown, true);
  assert.equal(second.shown, false);
  assert.deepEqual(counters, ['feedback_prompt_shown']);
  document.elements['feedback-dialog'].close();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(document.elements['feedback-dialog'].closeCount, 1);
  assert.equal(document.elements['feedback-review-btn'].listeners.get('click').length, 0);
  assert.equal(document.activeElement.id, 'options-link');
});


test('dismissing Feedback after a failed page opening preserves its already saved completion', async () => {
  const document = createFeedbackDocument();
  const previousChrome = globalThis.chrome;
  const previousBrowser = globalThis.browser;
  globalThis.browser = globalThis.chrome = { i18n: { getMessage: key => key } };
  try {
    const h = await openEligiblePrompt(document, { tabsApi: { async create() { throw Error('page unavailable'); } } });
    await document.elements['feedback-support-btn'].emit('click');
    await document.elements['feedback-close-btn'].emit('click');
    assert.equal(h.localStorage.data[FEEDBACK_STATE_KEY].completed, true);
    assert.equal(h.localStorage.data[FEEDBACK_STATE_KEY].lastAction, 'dismissed');
  } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
});
