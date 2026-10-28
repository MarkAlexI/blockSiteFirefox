# DNR readiness during browser startup

Test-only addition to 5.5.4. No runtime, manifest, permission or telemetry change.

## What is measured

Production rules target `main_frame`. The probe records an allowed HTTP control,
then navigates that same top-level document to a ruled host. It never fetches
the ruled URL as a substitute for navigation and never tests a subframe rule.
Before setup, that exact target host must reach the real loopback fixture. After
seeding a production `always` rule, a warm navigation must redirect to the real
packaged `blocked.html` with the expected host and `reason=always`.

The same profile is then restarted persistently, with a new browser PID. Before
opening extension UI, obtaining its worker/event page, reading DNR/storage or
sending a readiness message, the ordinary HTTP driver attempts the navigation.
If it reaches HTTP, the fixture records that attempt and retries after 50 ms.
The first observed native extension redirect is paired with a positive control
receipt and the absence of that attempt at the target server. DNS failures,
HTTP errors, stale documents and unrelated extension pages cannot pass the oracle.
The fixture is token-scoped, uncached and limited to 1000 attempts. The existing
15-second functional observation deadline is unchanged; there is no speed budget.

| Target | Start and observation scope |
| --- | --- |
| Chromium scenario 66, CI `lifecycle` | Native full-process exit/relaunch, same installed profile, 12 restored CPU-pressure tabs plus one active unruled driver. Driver runs during native restore before CDP attachment. An independent observer starts after CDP attachment, before tracing/routes or waiting for CPU pressure. Popup measurement does not wait for DNR readiness. |
| Firefox Desktop scenario 66, CI `core` | Persistent process quit/relaunch. First controlled navigation starts after WebDriver/BiDi and network setup but before the packaged extension probe, startup polling or Popup. This does not measure the browser's earliest restored-tab traffic. |

New navigation events may naturally start the background context. The test does
not claim the background remained asleep, nor identify which initialization phase
was running when DNR first applied. Firefox's existing enabled static bootstrap
ruleset is preserved. Firefox Android, Edge, Safari and minimum-version native
acceptance are outside these runs.

## JSON evidence and interpretation

Chromium keeps attachment `cold-startup-popup-measurement`, schema version 2,
adding independent `dnr` evidence alongside the existing first-response/Popup/input measurements.
Its `dnrPartial` is retained on failure. Firefox writes
`test-results/66/cold-startup-dnr-measurement.json`, including partial evidence
on failure. Existing CI artifact uploads already include both report paths.
Both record browser/version, process identity and OS/CPU/Node/memory identity.

| DNR field | Interpretation |
| --- | --- |
| `observationFloorAt - launchedAt` | Observer attachment/setup delay. |
| `firstProbeStartedMs` | First positive-control receipt after launch, before navigation dispatch; the browser still awaits the loopback acknowledgement. |
| `firstBlockedAttemptStartedMs` | Receipt for the final attempted navigation that produced the observed redirect. |
| `firstBlockedObservedMs` | Upper bound from launch to confirmed native blocking. Includes observer/setup and polling overhead. |
| `firstAttemptBlocked` | Whether the first sampled navigation was blocked. |
| `earlyAllowedRequests` / `allowedRequests` | Count and receipts of attempts that actually reached HTTP before the first block. |
| `observedBeforePopup` (Chromium) | Whether native blocking was confirmed before the Popup command; confirmation is not a gate for that command. |

If the first attempt is blocked, DNR may already have worked earlier. This is not
an exact engine-ready timestamp or a guarantee about traffic before observation.
An early allowed request remains visible in JSON (and a Chromium test annotation);
there is deliberately no invented latency or zero-leakage CI threshold. The
functional test fails if no native block is observed or the proof is inconsistent.
A green measurement is not a claim that every startup navigation was protected.
Compare the DNR upper bound with `launchToFirstReplyMs` and
`launchToPopupReadyMs` only within the same Chromium run and comparable machines.
Firefox does not claim a true native Popup timing from its packaged probe tab.
The existing CPU receipts prove pressure during the Popup interval only. DNR is
observed without waiting for that workload gate, so its sample does not claim the
same CPU pressure.
Schema version 2 adds a thirteenth restored driver tab and an observer. Establish
a new native baseline; do not treat schema-1 and schema-2 timings as identical setups.

## Local execution

From the corresponding repository root, install its pinned E2E dependencies with
`npm --prefix e2e ci`. Native binaries/X11 tools are installed by the existing CI.
Build and unpack the current store package following the main E2E README.

Chromium, inside `e2e`:

```bash
xvfb-run -a node node_modules/playwright/cli.js test startup-responsiveness.spec.mjs
```

Firefox Desktop, inside `e2e` (persistent Developer Edition/Nightly or signed XPI):

```bash
xvfb-run -a node runner.mjs --headed --filter=66
```

`node --test tests/dnrReadiness.test.js` exercises the actual HTTP fixture,
serialized navigation producer and acceptance/negative controls. It is not a
native benchmark. Check the delivery checkpoint for checks actually completed;
listing, syntax and Node tests cannot supply a missing browser measurement.

## Evidence motivating this measurement

- [Chrome DNR contract](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest): dynamic rules survive browser sessions, so UI readiness does not define enforcement readiness.
- [Mozilla bug 1821676](https://bugzilla.mozilla.org/show_bug.cgi?id=1821676): as checked October 28, 2026, still NEW; documents the separate issue of startup traffic preceding DNR loading.
- [Mozilla bug 1921353](https://bugzilla.mozilla.org/show_bug.cgi?id=1921353): historical restart/cache defect fixed in Firefox 133 and ESR branches; its old symptoms are not evidence of a current extension defect.
