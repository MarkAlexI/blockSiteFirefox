import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_STATE_KEY,
  FEEDBACK_INITIAL_DELAY_MS,
  FEEDBACK_SNOOZE_MS,
  FEEDBACK_MAX_PROMPTS,
  hasMeaningfulFeedbackUsage,
  shouldShowFeedbackPrompt,
  createFeedbackPromptController
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
