# Interrupted mutations and sampled DNR continuity

Tests only, extension **5.5.4**. No runtime, manifest, permission, sound or
telemetry change. The browser variants retain their actual background models:
Chromium MV3 service worker and Firefox Desktop event page.

## Native process interruption: 70–71

The production `rules:update` command splits a shared exhausted Daily Limit
assignment onto a new target. The initial rules and budgets are fixtures, but
the pending remap and the split are produced by that real command, not seeded.
A wrapper forwards the native storage call and holds delivery of its completed
Promise at one of two points:

| Scenario | Held result | Required native state before interruption |
| --- | --- | --- |
| 70 | Rules plus pending-remap write | New split exists, journal names its real ID, old assignment still owns 840 seconds. |
| 71 | Usage plus empty-journal write | New assignment owns exactly 840 seconds, source key is absent, journal is empty. |

The request must still be awaiting its reply. The test verifies its own browser
PID and exact temporary profile twice through Linux `/proc`, then sends only
that PID `SIGKILL` and proves the original process stopped. Chromium also proves
the spawned child's signal exit. Firefox closes the dead session's BiDi and
geckodriver connections; it does not call `driver.quit()` to induce the crash.
The same installed profile is relaunched with a new PID, without reseeding or
sending a corrective mutation. Native startup must recover the committed rules,
generation/revisions, credentials and budgets, clear the remap, and enforce the
new exhausted target. Options and Popup must display exhaustion. A second clean
process restart must preserve that exact result, including unrelated budgets.

This is an induced browser-process interruption after a real storage API
completion. It is not power-loss/fsync durability, kernel failure, an automatic
idle unload, a natural crash reproduction, or a claim about Android. No browser
database is edited, no stale profile lock is removed, and no API result is
fabricated. The existing native startup installer and lifecycle assertions stay
strict. A failed launch or a missing checkpoint is a failure, not acceptance.

## Native navigation and DNR history: 72

The unchanged sentinel is active in both General and Study. Three genuine
production intents edit a target, import a replacement backup and activate Study.
The first matching `updateDynamicRules` call is held before native invocation,
then again after native completion but before its result is delivered.

Every sampled ruled navigation starts with a unique, uncached positive HTTP
control in the same top-level tab. Actual target HTTP receipts and the committed
document distinguish an allowed request from the installed extension's genuine
`blocked.html?url=...&reason=always` redirect. All target hosts must be reachable
before rules are seeded. No `fetch()` or subframe substitutes for DNR navigation.
Chromium uses an owned loopback HTTP server and native resolver mapping;
Firefox uses the existing non-forwarding loopback proxy.

The sentinel is sampled before the command, before commit, concurrently with
native invocation, after native completion and after the successful reply.
Affected old/new hosts must exchange their native allowed/blocked outcomes at
commit; the successful reply cannot report pending synchronization. The final
oracle also rechecks the complete receipt history, so a late HTTP receipt cannot
erase an earlier leak. Every observed background DNR completion must retain the
sentinel; a final repaired state cannot erase an observed intermediate omission.

These are finite navigation samples and snapshots of observed background API
completions, not proof about every possible interleaving, every network request
or engine-internal timing. Wrappers preserve native results and expose only
explicit waits. The test does not impose a zero-startup-leakage budget or change
the separate startup measurement. Browser APIs, clocks, packaged blocking pages
and the production mutation methods remain real.

## Execution and evidence

Chromium: from `e2e`, after the normal packaged-extension preparation:

```sh
xvfb-run -a node node_modules/playwright/cli.js test mutation-recovery.spec.mjs
```

Firefox Desktop: from `e2e`, with its normal persistent installation:

```sh
xvfb-run -a node runner.mjs --headed --filter=70
xvfb-run -a node runner.mjs --headed --filter=71
xvfb-run -a node runner.mjs --headed --filter=72
```

Chromium adds the three scenarios to the existing lifecycle CI group. Firefox
adds them to core. Workflows and retries are unchanged. Native evidence is saved
as Chromium attachments or Firefox result entries, including the reached stage,
checkpoint, signal/PIDs, recovered state, API history and HTTP receipts on failure.

Node tests cover serialized gate forwarding, native error propagation, process
ownership guards, cleanup of interrupted waits and rejection of damaged evidence.
The actual SIGKILL and new-process/profile assertions are in the native E2E,
where an unavailable process identity is a failure rather than a skipped crash.
Node/API models and test enumeration do not establish native browser acceptance.
See the delivery checkpoint for tests actually executed.

## Relevant contracts

- [Chrome DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest): a single dynamic-rules update is atomic; dynamic rules persist across sessions and extension updates.
- [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): prepare for unexpected termination and persist state.
- [Mozilla storage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage): asynchronous extension-scoped storage; desktop tests do not establish Android lifecycle behavior.
