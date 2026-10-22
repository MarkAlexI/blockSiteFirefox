import { keepDialogFocus, restoreDialogFocus } from '../dom/dialogFocus.js';
import { t } from '../scripts/t.js';
import { REVIEWS_LINK, SUPPORT_LINK } from '../utils/constants.js';
import { recordTelemetryCounter } from '../telemetry/telemetryCounterReporter.js';

const feedbackPrompts = new WeakSet();

export const FEEDBACK_STATE_KEY = 'feedbackPromptState';
export const FEEDBACK_INITIAL_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
export const FEEDBACK_REPEAT_DELAY_MS = 21 * 24 * 60 * 60 * 1000;
export const FEEDBACK_MAX_PROMPTS = 3;
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
  if (
    normalizedState.promptCount > 0 &&
    normalizedState.lastPromptedAt > 0 &&
    now - normalizedState.lastPromptedAt < FEEDBACK_REPEAT_DELAY_MS
  ) return false;
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

  async function openReview(state, onStateSaved = () => {}) {
    const nextState = await complete(state, 'review');
    onStateSaved(nextState);
    await tabsApi.create({ url: reviewUrl });
    return nextState;
  }

  async function openSupport(state, onStateSaved = () => {}) {
    const nextState = await complete(state, 'support');
    onStateSaved(nextState);
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
  if (!dialog || !localStorage || !syncStorage || !tabsApi || feedbackPrompts.has(dialog) || dialog.open) return false;
  feedbackPrompts.add(dialog);

  const controller = createFeedbackPromptController({
    localStorage, syncStorage, tabsApi, now, reviewUrl
  });
  let state;
  try {
    const evaluation = await controller.evaluate();
    if (!evaluation.shouldShow) {
      feedbackPrompts.delete(dialog);
      return false;
    }
    state = await controller.markShown(evaluation.state);
  } catch {
    feedbackPrompts.delete(dialog);
    return false;
  }

  const opener = documentRef.activeElement;
  const closeButton = documentRef.getElementById('feedback-close-btn');
  const reviewButton = documentRef.getElementById('feedback-review-btn');
  const supportButton = documentRef.getElementById('feedback-support-btn');
  const errorElement = documentRef.getElementById('feedback-error');

  let finalized = false;
  let busy = false;
  const listeners = [];
  const listen = (element, type, listener) => {
    if (!element) return;
    element.addEventListener(type, listener);
    listeners.push(() => element.removeEventListener(type, listener));
  };
  const setBusy = value => {
    busy = value;
    dialog.setAttribute('aria-busy', String(value));
    if (value && [reviewButton, supportButton].includes(documentRef.activeElement)) closeButton?.focus();
    if (reviewButton) reviewButton.disabled = value;
    if (supportButton) supportButton.disabled = value;
  };
  const finish = () => {
    if (finalized) return;
    finalized = true;
    listeners.forEach(remove => remove());
    feedbackPrompts.delete(dialog);
    setBusy(false);
    if (dialog.open) dialog.close();
    restoreDialogFocus(opener, documentRef.getElementById('options-link'), documentRef.getElementById('add-rule'));
  };

  const dismiss = async () => {
    if (finalized) return;
    // An already-started action owns its completion write. Dismiss immediately,
    // without racing it with a second write or waiting for storage to respond.
    const actionPending = busy;
    finish();
    recordCounter('feedback_dismissed');
    if (!actionPending) {
      try { state = await controller.markDismissed(state); } catch { /* Closing remains available offline. */ }
    }
  };
  const runAction = async (action, counter) => {
    if (finalized || busy) return;
    if (errorElement) errorElement.textContent = '';
    setBusy(true);
    recordCounter(counter);
    try {
      // Retain a committed state even if opening the external page fails.
      state = await controller[action](state, saved => { state = saved; });
      if (!finalized) finish();
    } catch {
      if (finalized) return;
      setBusy(false);
      if (errorElement) errorElement.textContent = t('feedback_action_error');
      // A disabled action may have held focus when the request started.
      closeButton?.focus();
    }
  };

  listen(closeButton, 'click', dismiss);
  listen(dialog, 'cancel', event => {
    event.preventDefault();
    return dismiss();
  });
  listen(dialog, 'close', () => {
    if (!dialog.open) return dismiss();
  });
  listen(dialog, 'keydown', event => keepDialogFocus(event, dialog));
  listen(dialog, 'click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) return dismiss();
  });
  listen(reviewButton, 'click', () => runAction('openReview', 'feedback_review_clicked'));
  listen(supportButton, 'click', () => runAction('openSupport', 'feedback_support_clicked'));

  if (errorElement) errorElement.textContent = '';
  try {
    dialog.showModal();
    closeButton?.focus();
  } catch {
    finish();
    return false;
  }
  recordCounter('feedback_prompt_shown');
  return true;
}
