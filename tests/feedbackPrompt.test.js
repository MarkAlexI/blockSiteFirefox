import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_STATE_KEY,
  FEEDBACK_INITIAL_DELAY_MS,
  FEEDBACK_SNOOZE_MS,
  FEEDBACK_MAX_PROMPTS,
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

test('feedback prompt requires meaningful local usage', () => {
  assert.equal(hasMeaningfulFeedbackUsage({ rules: [{}, {}] }), true);
  assert.equal(hasMeaningfulFeedbackUsage({
    rules: [{}],
    statistics: { totalBlocked: 5 }
  }), true);
  assert.equal(hasMeaningfulFeedbackUsage({
    statistics: { successfulFocusSessions: 1 }
  }), true);
  assert.equal(hasMeaningfulFeedbackUsage({
    rules: [{}],
    statistics: { totalBlocked: 2, totalRedirects: 2 }
  }), false);
});

test('feedback prompt waits seven days even for an active user', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate: new Date(now - FEEDBACK_INITIAL_DELAY_MS + 1).toISOString(),
    state: {},
    rules: [{}, {}]
  }), false);

  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate: new Date(now - FEEDBACK_INITIAL_DELAY_MS).toISOString(),
    state: {},
    rules: [{}, {}]
  }), true);
});

test('feedback prompt is shown at most twice and respects the snooze interval', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const installationDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate,
    state: { promptCount: 1, lastPromptedAt: now - FEEDBACK_SNOOZE_MS + 1 },
    rules: [{}, {}]
  }), false);

  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate,
    state: { promptCount: 1, lastPromptedAt: now - FEEDBACK_SNOOZE_MS },
    rules: [{}, {}]
  }), true);

  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate,
    state: { promptCount: FEEDBACK_MAX_PROMPTS, lastPromptedAt: 0 },
    rules: [{}, {}]
  }), false);
});

test('completed feedback state never prompts again', () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  assert.equal(shouldShowFeedbackPrompt({
    now,
    installationDate: '2026-01-01T00:00:00Z',
    state: { completed: true },
    rules: [{}, {}]
  }), false);
});

test('legacy feedback completion is migrated from sync storage', async () => {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const localStorage = createStorage({
    rules: [{}, {}],
    statistics: { totalBlocked: 10 }
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
  class Element {
    constructor() {
      this.listeners = new Map();
      this.open = false;
      this.closeCount = 0;
    }

    addEventListener(type, listener, options = {}) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ listener, once: options?.once === true });
      this.listeners.set(type, listeners);
    }

    async emit(type, event = {}) {
      const listeners = [...(this.listeners.get(type) || [])];
      for (const entry of listeners) {
        await entry.listener(event);
        if (entry.once) {
          const current = this.listeners.get(type) || [];
          this.listeners.set(type, current.filter(item => item !== entry));
        }
      }
    }

    showModal() {
      this.open = true;
    }

    close() {
      this.open = false;
      this.closeCount += 1;
    }

    getBoundingClientRect() {
      return { left: 0, right: 100, top: 0, bottom: 100 };
    }
  }

  const elements = {
    'feedback-dialog': new Element(),
    'feedback-close-btn': new Element(),
    'feedback-review-btn': new Element(),
    'feedback-support-btn': new Element()
  };

  return {
    elements,
    getElementById(id) {
      return elements[id] || null;
    }
  };
}

function createEligibleFeedbackStorage() {
  return {
    localStorage: createStorage({ rules: [{}, {}] }),
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
