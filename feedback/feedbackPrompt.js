import { REVIEWS_LINK, SUPPORT_LINK } from '../utils/constants.js';

export const FEEDBACK_STATE_KEY = 'feedbackPromptState';
export const FEEDBACK_INITIAL_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export const FEEDBACK_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
export const FEEDBACK_MAX_PROMPTS = 2;
export const FEEDBACK_MIN_HANDLED_REQUESTS = 5;
export const FEEDBACK_MIN_RULES = 2;

function asTimestamp(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeState(state = {}) {
  return {
    completed: state.completed === true,
    promptCount: Math.max(0, Math.min(
      FEEDBACK_MAX_PROMPTS,
      Math.floor(Number(state.promptCount) || 0)
    )),
    lastPromptedAt: Math.max(0, Number(state.lastPromptedAt) || 0),
    lastAction: typeof state.lastAction === 'string' ? state.lastAction : null
  };
}

export function hasMeaningfulFeedbackUsage({ rules = [], statistics = {} } = {}) {
  const ruleCount = Array.isArray(rules) ? rules.length : 0;
  const handledRequests =
    Math.max(0, Number(statistics.totalBlocked) || 0) +
    Math.max(0, Number(statistics.totalRedirects) || 0);
  const completedFocusSessions = Math.max(
    0,
    Number(statistics.successfulFocusSessions) || 0
  );

  return ruleCount >= FEEDBACK_MIN_RULES ||
    handledRequests >= FEEDBACK_MIN_HANDLED_REQUESTS ||
    completedFocusSessions >= 1;
}

export function shouldShowFeedbackPrompt({
  now = Date.now(),
  installationDate,
  state = {},
  rules = [],
  statistics = {}
} = {}) {
  const normalizedState = normalizeState(state);
  const installedAt = asTimestamp(installationDate);

  if (normalizedState.completed) return false;
  if (normalizedState.promptCount >= FEEDBACK_MAX_PROMPTS) return false;
  if (!installedAt || now - installedAt < FEEDBACK_INITIAL_DELAY_MS) return false;
  if (!hasMeaningfulFeedbackUsage({ rules, statistics })) return false;

  if (
    normalizedState.lastPromptedAt > 0 &&
    now - normalizedState.lastPromptedAt < FEEDBACK_SNOOZE_MS
  ) {
    return false;
  }

  return true;
}

async function loadFeedbackContext({ localStorage, syncStorage }) {
  const [localResult, syncResult] = await Promise.all([
    localStorage.get([FEEDBACK_STATE_KEY, 'rules', 'statistics']),
    syncStorage.get(['credentials', 'ui_prefs'])
  ]);

  let state = localResult?.[FEEDBACK_STATE_KEY];

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    const legacy = syncResult?.ui_prefs?.feedback;
    state = normalizeState({
      completed: legacy?.completed === true,
      promptCount: Number(legacy?.last_prompted) > 0 ? 1 : 0,
      lastPromptedAt: Number(legacy?.last_prompted) || 0,
      lastAction: legacy?.completed === true ? 'legacy_completed' : null
    });

    if (legacy) {
      await localStorage.set({ [FEEDBACK_STATE_KEY]: state });
    }
  } else {
    state = normalizeState(state);
  }

  return {
    state,
    rules: Array.isArray(localResult?.rules) ? localResult.rules : [],
    statistics: localResult?.statistics || {},
    installationDate: syncResult?.credentials?.installationDate || null
  };
}

async function writeState(localStorage, state) {
  const normalized = normalizeState(state);
  await localStorage.set({ [FEEDBACK_STATE_KEY]: normalized });
  return normalized;
}

export function createFeedbackPromptController({
  localStorage,
  syncStorage,
  tabsApi,
  now = () => Date.now(),
  reviewUrl = REVIEWS_LINK,
  supportUrl = SUPPORT_LINK
}) {
  async function evaluate() {
    const context = await loadFeedbackContext({ localStorage, syncStorage });
    return {
      ...context,
      shouldShow: shouldShowFeedbackPrompt({
        now: now(),
        installationDate: context.installationDate,
        state: context.state,
        rules: context.rules,
        statistics: context.statistics
      })
    };
  }

  async function markShown(state) {
    return writeState(localStorage, {
      ...state,
      promptCount: (Number(state?.promptCount) || 0) + 1,
      lastPromptedAt: now(),
      lastAction: 'shown'
    });
  }

  async function markDismissed(state) {
    return writeState(localStorage, {
      ...state,
      lastAction: 'dismissed'
    });
  }

  async function complete(state, action) {
    return writeState(localStorage, {
      ...state,
      completed: true,
      lastAction: action
    });
  }

  async function openReview(state) {
    const nextState = await complete(state, 'review');
    await tabsApi.create({ url: reviewUrl });
    return nextState;
  }

  async function openSupport(state) {
    const nextState = await complete(state, 'support');
    await tabsApi.create({ url: supportUrl });
    return nextState;
  }

  return {
    evaluate,
    markShown,
    markDismissed,
    openReview,
    openSupport
  };
}

export async function initFeedbackPrompt({
  documentRef = globalThis.document,
  localStorage = globalThis.browser?.storage?.local,
  syncStorage = globalThis.browser?.storage?.sync,
  tabsApi = globalThis.browser?.tabs,
  now = () => Date.now(),
  reviewUrl = REVIEWS_LINK
} = {}) {
  const dialog = documentRef?.getElementById('feedback-dialog');
  if (!dialog || !localStorage || !syncStorage || !tabsApi) return false;

  const controller = createFeedbackPromptController({
    localStorage,
    syncStorage,
    tabsApi,
    now,
    reviewUrl
  });

  const evaluation = await controller.evaluate();
  if (!evaluation.shouldShow) return false;

  let state = await controller.markShown(evaluation.state);
  let finalized = false;

  const closeButton = documentRef.getElementById('feedback-close-btn');
  const reviewButton = documentRef.getElementById('feedback-review-btn');
  const supportButton = documentRef.getElementById('feedback-support-btn');

  async function dismiss() {
    if (finalized) return;
    finalized = true;
    state = await controller.markDismissed(state);
    dialog.close();
  }

  closeButton?.addEventListener('click', () => {
    void dismiss();
  }, { once: true });

  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    void dismiss();
  }, { once: true });

  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) void dismiss();
  });

  reviewButton?.addEventListener('click', async () => {
    if (finalized) return;
    finalized = true;
    state = await controller.openReview(state);
    dialog.close();
  }, { once: true });

  supportButton?.addEventListener('click', async () => {
    if (finalized) return;
    finalized = true;
    state = await controller.openSupport(state);
    dialog.close();
  }, { once: true });

  dialog.showModal();
  return true;
}
