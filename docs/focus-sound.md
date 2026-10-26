# Focus completion sound, 5.5.0

The existing synced `settings.focusSessionSound` preference controls a finite,
locally generated two-note chime after a committed Focus completion. Its default
and Free/Pro availability are unchanged. Listen in Options is an explicit preview
and does not modify that preference or the Focus session. All new UI strings are
translated in all 57 locales.

The signal uses Web Audio at the device's media volume. It is separate from OS
notification channels, their volume, and vibration. Browser execution does not
prove that physical speakers are audible or establish behavior under Android
Do Not Disturb, battery restrictions, a locked screen or a terminated browser.

## Platform execution and failure behavior

- Chromium creates the packaged `scripts/sound-offscreen.html` only on demand,
  with the `offscreen` permission and `AUDIO_PLAYBACK` reason. The page supports
  only a named built-in sound, not arbitrary URLs. It is closed after playback
  or a failure. Discovery uses `runtime.getContexts` with the documented client
  fallback for Chrome 109-115. Unavailable APIs leave visual completion intact.
- Firefox uses Web Audio in its DOM event page and needs no additional
  permission or offscreen page. Autoplay is normally permitted for extension
  pages; a user/browser policy can still deny it. Every attempt releases its
  oscillators, gains and AudioContext.
- Chromium completion notifications use `silent: true` to avoid adding the OS
  tone to the built-in chime. Firefox notifications omit unsupported `silent`;
  their own system sound behavior remains controlled by Firefox/the OS.
- A serialized owner covers preparation, playback and cleanup. Concurrent
  requests coalesce; recent request IDs are deduplicated. A bounded caller
  timeout does not release an unresolved owner, so a late document creation
  cannot play a delayed sound or race a newer document's cleanup.
- A sound preference change is checked again before playback. No silent audio
  loop, permanently open document, media download or keepalive is used.

Sound is best effort after durable Focus completion. Notification and audio
run independently and do not hold the state mutation queue. A process crash
between the saved completion and playback can lose the chime; recovery does
not replay completed sessions. The existing serialized Focus recovery rejects
duplicate/stale alarms. Manual Stop and invalid-state recovery do not chime.
Valid completions more than 60 seconds late keep their visual notification but
skip sound. The existing one-second early-alarm tolerance is preserved.

## Verification

Focused Node tests exercise real production methods with controlled Web API
models: envelopes, resource cleanup, autoplay denial, delayed creation/resume,
timeouts, duplicates, notification failure, freshness, sender validation,
preference changes, preview status, later focus/drafts and explicit retry.

Native browser scenario 68 requests a preview with no content user activation,
uses one trusted Listen click, preserves the disabled preference, then triggers
production completion with a real native alarm on a controlled near-future
deadline fixture. Firefox observes real generated signal energy and context
closure through a parallel analyser; Chromium observes creation and destruction
of actual offscreen contexts. Playback/responses/ended events are not replaced.
This is not a real 25-minute session or a physical audio/device acceptance test.

Run the focused browser scenario through the existing runner:

```sh
# Chromium, from e2e/:
npm test -- focus-sound.spec.mjs
# Firefox, from e2e/:
node runner.mjs --filter=68
```

Local 2026-10-26 native Firefox 158.0b2/geckodriver 0.37.1 was blocked before
scenario entry: `Sandbox: writing /proc/self/uid_map: EPERM`, content-process
crash, then Marionette disconnect. No native sound assertion ran locally.
Hosted CI acceptance of scenario 68 is still required. Browser/host sandbox
restrictions have not been disabled to bypass that failure.

On a real Android device: preview with the toggle off; finish a short session
with it on; repeat with it off; try a session while Firefox is backgrounded and
with the screen locked. Record Firefox/Android versions, media volume and power
state. Check actual sound, visual notification, absence of repeated chimes and
normal rule recovery. Desktop narrow layouts do not cover those checks.

References: [Chrome offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
[Chrome notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications),
[Firefox background environment](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts),
[Firefox autoplay preferences](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay#browser_configuration_options),
[Firefox notification schema](https://github.com/mozilla-firefox/firefox/blob/main/toolkit/components/extensions/schemas/notifications.json).
