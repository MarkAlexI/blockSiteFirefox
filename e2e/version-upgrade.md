# Native version-update preservation — scenario 67

Tests only, based on `8cef9a19114cd8e521d7e111f0faa6ff825a783c`. Runtime remains **5.4.15**.
Current inventory: **65 = 63 core + 1 overdue + 1 upgrade**. CI runs the new
`upgrade` group separately, and the existing required `e2e` check requires all
three groups. Existing test deadlines and retry policy are unchanged.

## Actual previous package

`upgrade-baseline.json` pins **5.4.14** at
`fd72823d413a588d9d345575e07b2d5d3e3b3bcc`. Preparation uses that commit's
actual store packager, verifies its build receipt and archive SHA-256, checks
ZIP CRC, and records hashes of the extracted runtime files. It does not edit
a current manifest to pretend to be an older release.

`prepare-upgrade-baseline.mjs` fetches the exact commit if missing from a shallow
checkout, creates an isolated detached Git worktree, and removes that worktree
after success or failure. The old runtime and receipt live under
`RUNNER_TEMP` / the system temporary directory, outside the repository; only a
small ignored pointer is written to `e2e/upgrade-baseline.local.json`, outside
the runner output directory so Playwright cleanup cannot remove it.
CI exports `BD_PREVIOUS_EXTENSION_PATH` for the next step. Keeping the historical
source outside the repository also prevents Node from discovering its old tests.

From the repository root, before running the new group or a full suite:

```bash
node e2e/prepare-upgrade-baseline.mjs
cd e2e
npm ci
# Set BD_FIREFOX_BINARY and BD_GECKODRIVER to the installed developer tools.
BD_E2E_GROUP=upgrade xvfb-run -a npm run test:headed
```

When `BD_EXTENSION_PATH` is set, the target is the unpacked current store
package. CI already builds it before preparing the previous runtime. The
previous package reader verifies its pinned version, commit and runtime hashes
again immediately before use.

## Native transition and assertions

Firefox installs the old XPI persistently, then installs one new unsigned XPI
with the same Gecko ID using native WebDriver `installAddon(..., false)`.
The parent-process ExtensionActivityLog observer records the actual background
`runtime.onInstalled` delivery. Browser PID, profile, AddonManager install date
and extension ID must stay unchanged, and the addon must remain non-temporary.
This requires Developer Edition/Nightly with the existing isolated development
profile settings. `BD_SIGNED_XPI` is rejected for this scenario because one
signed target cannot supply the required pair of development packages.

Before replacement, the real old runtime receives two rules, multiple list
assignments, Pro test credentials, a non-default setting and spent Daily Limit
budgets of 45/60 seconds and 840/1200 seconds. The old Popup starts a real
five-minute Focus session; its schedule is saved through the production router.
A durable marker distinguishes preserved storage from a fresh fixture.
There are no fixture writes after the update.

Acceptance requires exactly one native update event with the correct previous
version and extension ID; preserved rules, lists, revisions, credentials,
settings, usage and migration journal; unchanged active Focus and deadline;
and the expected native DNR rules and native alarms. The browser timezone keeps
this preservation case away from a legitimate local-day rollover without
changing the host clock.

The reopened current Popup must acknowledge readiness and accept one real Stop
click. The remaining 15 seconds are then consumed by a real foreground tab,
with a future native Daily Limit alarm and actual DNR blocking at exhaustion.
The inactive list's 840 seconds must remain unchanged. A final event read rejects
late duplicate deliveries. Node negative controls reject install, same-version
reload, restart, different ID/profile, duplicate events and lost state.

## Verification and scope

- `npm run check`: **2238/2238** Node tests, extension validation and 70 contrast
  pairs passed. All 65 scenarios enumerate; enumeration is not execution.
- The pinned historical package prepares from a fresh shallow checkout. A
  real-Git regression checks private worktree cleanup after success and a
  controlled build failure while preserving the current checkout.
- Native Linux headless **Firefox Developer Edition 158.0b2 / geckodriver
  0.37.1** passed scenario 67, **1/1**, with one real update event and the same
  PID, profile, ID and install date. Spent usage was **45 -> 45 -> 60** seconds;
  the other profile remained at **840** seconds. Focus retained its exact
  original end time. The report includes native identities and before/after
  state, and `67/native-version-upgrade.json` retains the detailed evidence.
- The preceding 64-scenario base passed in
  [run 40307429560](https://github.com/MarkAlexI/blockSiteFirefox/actions/runs/40307429560).
  Full headed CI including the new `upgrade` group remains pending after the
  owner applies and pushes the patch.

This tests native development-package upgrade behavior. It does not establish
signed store automatic-update delivery, Edge/Safari, Android, macOS or minimum
browser-version acceptance. Runtime sources, manifests, version and
`update/update.js` are unchanged.
