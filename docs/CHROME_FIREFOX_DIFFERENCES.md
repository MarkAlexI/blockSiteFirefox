# Chromium and Firefox differences

This document describes **intentional platform differences** between the Chromium and Firefox versions of BlockDistraction.

Its purpose is not to mirror every line-level diff between the repositories. Many files differ only because Chromium uses `chrome.*` APIs while Firefox primarily uses `browser.*`. Those mechanical differences are expected.

The important rule is:

> If a difference is not documented here and is not a mechanical `chrome.*` / `browser.*` API adaptation, treat it as a candidate for synchronization between the Chromium and Firefox codebases.

The Chromium repository is the primary development target. Product changes are normally implemented and tested there first, then ported to Firefox with the platform-specific differences in this document preserved.

---

## 1. High-level platform matrix

| Area | Chromium | Firefox | Intentional |
| --- | --- | --- | --- |
| Primary API namespace | `chrome.*` | `browser.*` | Yes |
| Background declaration | MV3 `service_worker` | module background `scripts` | Yes |
| Store targets | Chrome Web Store + Edge Add-ons | Mozilla Add-ons | Yes |
| Store selection | build-time `storeTarget` | fixed AMO target | Yes |
| Telemetry consent | custom opt-in | Firefox native data-collection permission when supported | Yes |
| Telemetry browser context | Chrome / Edge / Chromium | Firefox | Yes |
| Firefox Android | not applicable | first-class supported target | Yes |
| Context menu | page + link where supported | link only | Yes |
| Protected store/browser URLs | Chrome/Edge-specific | Firefox/AMO-specific | Yes |
| Review URL | selected by Chromium store target | fixed AMO reviews URL | Yes |
| CI release artifacts | separate CWS and Edge packages | Firefox validation/lint path | Yes |

---

## 2. Manifest

### Chromium

`manifest.json` uses the Chromium MV3 service worker declaration:

```json
"background": {
  "service_worker": "scripts/service_worker.js",
  "type": "module"
}
```

### Firefox

Firefox uses the module background script form:

```json
"background": {
  "scripts": [
    "scripts/service_worker.js"
  ],
  "persistent": false,
  "type": "module"
}
```

Firefox also has `browser_specific_settings` containing:

- the fixed Gecko extension ID;
- the minimum desktop Firefox version;
- the minimum Firefox for Android version;
- the native optional telemetry data-collection permission.

Current Firefox-specific declaration:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "{397e704c-6038-4647-8d15-35040d68b032}",
    "strict_min_version": "113.0",
    "data_collection_permissions": {
      "required": ["none"],
      "optional": ["technicalAndInteraction"]
    }
  },
  "gecko_android": {
    "id": "{397e704c-6038-4647-8d15-35040d68b032}",
    "strict_min_version": "120.0"
  }
}
```

Do not copy the Chromium background declaration over the Firefox one during a port.

Do not remove or replace the Gecko ID or Firefox data-collection declaration unless the change is intentional and has been reviewed for AMO compatibility.

For BlockDistraction, keep both `required: ["none"]` and optional `technicalAndInteraction`. The Firefox/AMO manifest validation path depends on this exact opt-in declaration, so do not simplify it to the optional entry alone during a Chromium-to-Firefox port.

---

## 3. WebExtension API namespace

The Chromium codebase uses `chrome.*` as its normal API surface.

The Firefox codebase primarily uses `browser.*`, especially for APIs whose natural Firefox form returns Promises.

Typical mappings include:

```text
chrome.runtime          -> browser.runtime
chrome.storage          -> browser.storage
chrome.tabs             -> browser.tabs
chrome.permissions      -> browser.permissions
chrome.alarms           -> browser.alarms
chrome.contextMenus     -> browser.contextMenus
chrome.notifications    -> browser.notifications
chrome.declarativeNetRequest -> browser.declarativeNetRequest
chrome.i18n             -> browser.i18n
```

Firefox also implements a large part of the Chrome-compatible API surface, so occasional `chrome.*` usage may still work there. That does **not** mean a broad search-and-replace in either direction is safe.

When porting a file, preserve the existing API style of the Firefox counterpart unless there is a deliberate reason to refactor it.

---

## 4. Runtime messaging: `sendMessage`

Messaging is one of the most important intentional differences.

### 4.1 Request/response messages

Chromium `rules/rulesClient.js` wraps the callback form of `chrome.runtime.sendMessage()` in a Promise:

```js
export function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          reject(new Error(
            lastError.message || 'Runtime messaging failed'
          ));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}
```

This wrapper deliberately reads `chrome.runtime.lastError` inside the callback and exposes a Promise to the rest of the application.

Firefox uses the native Promise returned by `browser.runtime.sendMessage()`:

```js
export function sendRuntimeMessage(message) {
  return browser.runtime.sendMessage(message);
}
```

Do **not** port the Chromium callback wrapper verbatim to Firefox.

Do **not** add a callback argument to the Firefox `browser.runtime.sendMessage()` form just because the Chromium implementation uses one.

### 4.2 Fire-and-forget messages

The same distinction matters when no response is needed.

Chromium commonly suppresses a missing receiver through the callback and `runtime.lastError`:

```js
chrome.runtime.sendMessage(message, () => {
  void chrome.runtime.lastError;
});
```

Firefox should treat `browser.runtime.sendMessage()` as a Promise and consume an expected rejection:

```js
const result = browser.runtime.sendMessage(message);

if (result && typeof result.catch === 'function') {
  result.catch(() => {});
}
```

`telemetry/pageErrorReporter.js` and `telemetry/telemetryCounterReporter.js` are examples of this intentional difference. The Firefox popup, onboarding, update/blocked/redirect pages, Pro status notifications, and service-worker `rules:changed` notification also follow the Promise-style contract.

This matters for messages that are allowed to have no active receiver. An unhandled rejected Promise in Firefox is not equivalent to Chromium's callback pattern with `runtime.lastError` consumed.

### 4.3 `runtime.onMessage` async responses

Do not confuse sender-side `sendMessage()` differences with listener-side response handling.

The current service worker uses the same compatibility-oriented listener pattern on both platforms:

```js
runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (shouldHandle(message)) {
    (async () => {
      const result = await doAsyncWork();
      sendResponse(result);
    })();

    return true;
  }
});
```

In the real files, `runtime` is `chrome.runtime` on Chromium and `browser.runtime` on Firefox.

The literal `return true` keeps the response channel open while asynchronous work completes.

Firefox can also return a Promise directly from an `onMessage` listener, and that is the natural Firefox style. However, the current BlockDistraction service worker deliberately retains the `sendResponse()` + `return true` pattern because it matches the cross-browser message contract used by the project.

Do not convert a listener to a blanket `async` function during a routine Chromium-to-Firefox port. If Promise-returning listeners are adopted, make that a deliberate messaging refactor and test all message types on both platforms.

Official references:

- MDN `runtime.sendMessage()`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/sendMessage
- MDN `runtime.onMessage`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage
- Chrome message passing: https://developer.chrome.com/docs/extensions/develop/concepts/messaging

---

## 5. Telemetry consent

Telemetry data and the telemetry wire protocol are intended to remain functionally aligned between Chromium and Firefox.

The **consent mechanism is intentionally different**.

### Chromium

Chromium uses the extension's own local opt-in state.

The telemetry client reads and updates the local consent record directly.

### Firefox

Firefox uses the native optional data-collection permission when the API is available:

```text
technicalAndInteraction
```

Relevant Firefox-specific files include:

```text
manifest.json
telemetry/telemetryConsent.js
telemetry/telemetryClient.js
options/options.js
scripts/service_worker.js
tests/telemetryConsent.test.js
tests/telemetryClient.test.js
```

Firefox `telemetryConsent.js`:

- checks `browser.permissions.getAll()` for native `data_collection`;
- treats the native permission as authoritative when supported;
- requests or removes `technicalAndInteraction` only from a user action, initiating `permissions.request()` before any asynchronous work so Firefox preserves the user gesture;
- falls back to local consent only where the native data-collection permission API is not supported;
- fails closed if the native API exists but cannot be queried.

The service worker also reacts to permission changes:

- adding the Firefox telemetry permission enables the effective telemetry consent;
- removing it disables telemetry and clears pending telemetry through the normal telemetry client behavior.

Do not replace this with the Chromium local-only consent implementation.

### Shared telemetry delivery protocol

The consent plumbing differs, but the telemetry wire protocol and delivery semantics should remain aligned across the two repositories.

Starting with version 4.8.4, both Chromium and Firefox use schema v2 delivery snapshots with a random UUID-v4 `deliveryId`. The ID belongs only to one prepared unacknowledged snapshot:

- it is not an installation or user identifier;
- retries of the same snapshot reuse the same ID;
- acknowledgement removes only the counters and errors contained in that snapshot;
- newer same-day events remain queued and receive a new ID on the next preparation;
- the server uses the ID to make schema-v2 ingestion idempotent.

`telemetry/telemetryStore.js` and the schema-v2 portions of `telemetry/telemetryClient.js` should therefore stay behaviorally aligned between Chromium and Firefox. Preserve only the Firefox-specific consent calls and browser context described in this document when porting telemetry delivery changes.

---

## 6. Telemetry browser context and sanitization

Telemetry must report the actual browser family.

### Chromium

`telemetry/telemetryContext.js` recognizes:

- Chrome;
- Edge;
- generic Chromium fallback.

`telemetry/telemetrySanitizer.js` allows:

```text
chrome
edge
chromium
```

### Firefox

The Firefox version recognizes Firefox and sanitizes the browser value against:

```text
firefox
```

This is intentional.

Do not copy the Chromium telemetry browser allowlist into Firefox. Doing so can silently mislabel or discard Firefox context.

---

## 7. Firefox Android

Firefox for Android is a first-class BlockDistraction target.

This is not merely the desktop Firefox build installed on another device.

Platform-sensitive behavior must be tested with Firefox Android in mind, especially:

- extension page behavior;
- tab closing;
- context menus;
- permissions;
- background lifecycle;
- store/onboarding links;
- UI dimensions and interaction;
- APIs that exist on desktop Firefox but have different Android support.

The manifest has a separate `gecko_android.strict_min_version` for this reason.

When a Chromium feature is ported to Firefox, mobile behavior must be considered even if the feature itself looks desktop-only.

---

## 8. Context menu behavior

The context menu is intentionally narrower in Firefox:

```js
contexts: IS_FIREFOX ? ['link'] : ['page', 'link']
```

Chromium can expose the Pro context action for both the page and a link.

Firefox uses the link context only.

Do not "synchronize" this difference by blindly copying the Chromium context list.

---

## 9. Protected and internal URLs

`scripts/isBlockedURL.js` is intentionally platform-specific.

### Chromium

Protected patterns include Chromium internal pages and store pages, such as:

```text
chrome://
chrome.google.com/webstore
chromewebstore.google.com
kiwi://
```

The Chromium version also adds store-target-specific protected patterns through `utils/storeTarget.js`.

For the Edge build, this is where Edge/Microsoft-specific protected URLs are added.

Those Edge-only restrictions must not leak into the default Chrome build.

### Firefox

Firefox protects Firefox-specific internal/store URLs, including:

```text
about:
addons.mozilla.org
```

There is no Chromium `storeTarget` layer in the Firefox repository.

Do not copy the Chromium protected URL list over the Firefox list.

---

## 10. Store target and review URL

### Chromium

The Chromium repository supports two release targets from one codebase:

```text
Chrome Web Store
Microsoft Edge Add-ons
```

The checked-in/default target is Chrome.

`utils/storeTarget.js` contains the store-specific configuration.

The build process creates separate CWS and Edge artifacts and changes only the build-time store target where possible.

The feedback prompt obtains the store name and review URL from this store configuration.

### Firefox

Firefox has only one store target:

```text
Mozilla Add-ons (AMO)
```

There is intentionally no `storeTarget.js`.

The AMO reviews URL is fixed in Firefox configuration:

```js
export const REVIEWS_LINK =
  'https://addons.mozilla.org/en-US/firefox/addon/blockersite/reviews/';
```

The feedback prompt receives this fixed review URL.

Do not add the Chromium Chrome/Edge store abstraction to Firefox unless Firefox gains a real second distribution target.

---

## 11. Feedback prompt

The product behavior should stay aligned:

- neutral review/support prompt;
- no review gating;
- minimum installation age;
- actual usage eligibility;
- maximum prompt count;
- snooze interval;
- legacy feedback-state migration.

The platform plumbing differs.

### Chromium

The feedback controller gets the active store configuration and opens the correct CWS or Edge review page.

### Firefox

The feedback controller uses the fixed AMO review URL and `browser.tabs`.

When porting future feedback changes, synchronize the **eligibility and state machine**, but preserve the store-specific URL/API wiring.

---

## 12. Closing extension tabs and pages

Firefox has cases where closing an extension page through page-local window behavior is less reliable, especially in the mobile environment.

For example, the Firefox blocked page requests tab closure through the background runtime:

```js
browser.runtime.sendMessage({
  type: 'close_current_tab'
});
```

The service worker owns the actual tab operation.

Do not replace Firefox-specific background-mediated closing with Chromium page-local behavior without testing desktop Firefox and Firefox Android.

---

## 13. Files expected to differ

The following files or areas are expected to contain meaningful platform differences.

### Manifest and platform configuration

```text
manifest.json
utils/constants.js
scripts/isBlockedURL.js
```

### Runtime messaging and background integration

```text
rules/rulesClient.js
scripts/service_worker.js
telemetry/pageErrorReporter.js
telemetry/telemetryCounterReporter.js
```

### Telemetry consent and browser identification

```text
telemetry/telemetryConsent.js
telemetry/telemetryClient.js
telemetry/telemetryContext.js
telemetry/telemetrySanitizer.js
options/options.js
```

### Store-facing behavior

```text
feedback/feedbackPrompt.js
index.html
```

### Platform behavior

```text
scripts/blocked.js
scripts/getCurrentTabs.js
scripts/closeTabs.js
onboarding/onboarding.js
```

Some additional UI, Pro, utility, test, and update files may differ only because of `chrome.*` / `browser.*` adaptation. Such mechanical differences should not be interpreted as separate product behavior.

---

## 14. Repository-only files and release tooling

Some files exist only in one codebase because the release process differs.

### Chromium-specific

Examples include:

```text
utils/storeTarget.js
tools/package-store.js
tests/storeTarget.test.js
```

The Chromium GitHub Actions workflow builds separate CWS and Edge packages from the same commit.

### Firefox-specific

Firefox includes AMO-specific metadata such as:

```text
metadata.json
```

The Firefox CI path runs the project checks and Firefox-specific `web-ext lint`.

These release-process differences are intentional and should not be synchronized mechanically.

---

## 15. Porting checklist: Chromium -> Firefox

When porting a Chromium release to Firefox:

1. Start from the latest Firefox release, not from a copy of the Chromium tree.
2. Port product logic, tests, documentation, and version changes.
3. Preserve Firefox `manifest.json` background and `browser_specific_settings`.
4. Convert new browser API calls to the established Firefox API style.
5. Review every new `runtime.sendMessage()` call:
   - request/response: prefer the Firefox Promise form;
   - fire-and-forget: consume expected Promise rejection;
   - do not copy Chromium callback + `runtime.lastError` handling blindly.
6. Review every changed `runtime.onMessage` path:
   - preserve the current `sendResponse()` + literal `return true` async contract unless deliberately refactoring messaging.
7. Preserve native Firefox telemetry consent and permission listeners.
8. Preserve Firefox telemetry browser detection and sanitizer allowlists.
9. Preserve Firefox/AMO protected URL rules.
10. Do not port Chromium `storeTarget.js` or Edge-only behavior.
11. Preserve the fixed AMO review URL.
12. Check Firefox context menu behavior.
13. Test tab closing and extension pages on Firefox Android.
14. Run the complete unit/validation suite.
15. Run `web-ext lint`.
16. Compare the final Firefox tree against Chromium and review every unexplained non-mechanical difference.

---

## 16. Porting checklist: Firefox fix -> Chromium

A Firefox-specific bug fix may still represent shared product logic.

Before leaving a fix only in Firefox, ask:

- Is the bug caused by `browser.*` / Firefox API semantics?
- Is it caused by Firefox Android?
- Is it caused by AMO or Firefox permissions?
- Is it caused by Firefox telemetry consent?
- Is it caused by Firefox internal/store URLs?

If the answer to all of those is no, the fix is probably a candidate for the Chromium repository too.

---

## 17. Drift policy

The two repositories should not become independent implementations of the same product.

Prefer:

- shared behavior;
- matching data structures;
- matching rule semantics;
- matching telemetry schema;
- matching UI and localization keys;
- matching tests for shared features;
- small, explicit platform adapters.

Avoid:

- copying whole Chromium files over Firefox equivalents;
- keeping undocumented "temporary" differences;
- adding Firefox checks throughout shared business logic when a small platform boundary can contain the difference;
- introducing store-specific behavior into core rule logic;
- assuming that a passing Chromium test proves Firefox Android behavior.

When a new intentional platform difference is introduced, update this document in the same release.

---

## 18. Quick rule for future maintenance

Before synchronizing a differing file, ask:

> Is this difference required by the browser, the store, Firefox Android, permissions, messaging semantics, or release packaging?

If yes, document and preserve it.

If no, investigate whether the repositories have drifted.
