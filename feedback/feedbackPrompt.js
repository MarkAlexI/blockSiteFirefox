import { REVIEWS_LINK, SUPPORT_LINK } from '../utils/constants.js';
import { recordTelemetryCounter } from '../telemetry/telemetryCounterReporter.js';

export const FEEDBACK_STATE_KEY = 'feedbackPromptState';
export const FEEDBACK_INITIAL_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
export const FEEDBACK_MAX_PROMPTS = 1;
export const FEEDBACK_MIN_HANDLED_REQUESTS = 20;
export const FEEDBACK_MIN_FOCUS_SESSIONS = 3;
export const FEEDBACK_MIN_ACTIVE_DAYS = 3;

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

function asCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function countFeedbackUsageDays(statistics = {}) {
  const history = statistics?.dailyHistory;
  if (!history || typeof history !== 'object' || Array.isArray(history)) return 0;

  return Object.values(history).filter(entry =>
    entry && typeof entry === 'object' &&
    asCounter(entry.blocked) + asCounter(entry.redirected) + asCounter(entry.focusSessions) > 0
  ).length;
}

export function hasMeaningfulFeedbackUsage({ statistics = {} } = {}) {
  const handledRequests =
    asCounter(statistics.totalBlocked) + asCounter(statistics.totalRedirects);
  const completedFocusSessions = asCounter(statistics.successfulFocusSessions);
  const activeDays = countFeedbackUsageDays(statistics);

  return activeDays >= FEEDBACK_MIN_ACTIVE_DAYS && (
    handledRequests >= FEEDBACK_MIN_HANDLED_REQUESTS ||
    completedFocusSessions >= FEEDBACK_MIN_FOCUS_SESSIONS
  );
}

export function shouldShowFeedbackPrompt({
  now = Date.now(),
  installationDate,
  state = {},
  statistics = {}
} = {}) {
  const normalizedState = normalizeState(state);
  const installedAt = asTimestamp(installationDate);

  if (normalizedState.completed) return false;
  if (normalizedState.promptCount >= FEEDBACK_MAX_PROMPTS) return false;
  if (!installedAt || now - installedAt < FEEDBACK_INITIAL_DELAY_MS) return false;
  if (!hasMeaningfulFeedbackUsage({ statistics })) return false;

  return true;
}

async function loadFeedbackContext({ localStorage, syncStorage }) {
  const [localResult, syncResult] = await Promise.all([
    localStorage.get([FEEDBACK_STATE_KEY, 'statistics']),
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
  reviewUrl = REVIEWS_LINK,
  recordCounter = recordTelemetryCounter
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
    recordCounter('feedback_dismissed');
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
    recordCounter('feedback_review_clicked');
    state = await controller.openReview(state);
    dialog.close();
  }, { once: true });

  supportButton?.addEventListener('click', async () => {
    if (finalized) return;
    finalized = true;
    recordCounter('feedback_support_clicked');
    state = await controller.openSupport(state);
    dialog.close();
  }, { once: true });

  dialog.showModal();
  recordCounter('feedback_prompt_shown');
  return true;
}
