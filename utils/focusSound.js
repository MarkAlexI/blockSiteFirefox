import { FOCUS_COMPLETE_SOUND } from './soundPlayer.js';

export const MAX_FOCUS_SOUND_LATENESS_MS = 60_000;

export function isRecentFocusCompletion(endTime, now = Date.now()) {
  return Number.isFinite(endTime) && endTime > 0 &&
    now >= endTime - 1000 && now - endTime <= MAX_FOCUS_SOUND_LATENESS_MS;
}

export function isSoundPreviewSender(sender, runtime) {
  if (!runtime.id || sender?.id !== runtime.id || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    url.search = ''; url.hash = '';
    return url.href === runtime.getURL('options/options.html');
  } catch { return false; }
}

export function createFocusSoundController({ service, getSettings, now = Date.now }) {
  let previewSequence = 0;
  return {
    async complete(endTime) {
      if (!isRecentFocusCompletion(endTime, now())) return { success: true, skipped: true };
      // A failed read must not fall back to sound=true and surprise the user.
      const settings = await getSettings({ throwOnError: true });
      if (settings.focusSessionSound !== true || !isRecentFocusCompletion(endTime, now())) {
        return { success: true, skipped: true };
      }
      return service.play(FOCUS_COMPLETE_SOUND, `focus:${endTime}`, async () => {
        const current = await getSettings({ throwOnError: true });
        return current.focusSessionSound === true && isRecentFocusCompletion(endTime, now());
      });
    },
    preview() {
      // Listening is an explicit action, independent of the saved preference.
      return service.play(FOCUS_COMPLETE_SOUND, `preview:${now()}:${++previewSequence}`);
    }
  };
}
