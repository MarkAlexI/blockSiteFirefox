# Toolbar Options reselection — 2026-10-24

## Confirmed failure and correction

At base `8015890eb6646f5ddb85ce1655bbae956b09eaa5`,
[run 40097104666](https://github.com/MarkAlexI/blockSiteFirefox/actions/runs/40097104666)
reported **61 passed / 1 failed / 0 blocked**, with all 62 bodies started.
Scenario 29 still failed before import. Its native X11 evidence now establishes
that the correct Firefox window was already active, while the visible Options
document had `hasFocus() === false` even after a trusted Search click.

The harness treated Classic WebDriver's current handle as sufficient evidence
that the target tab was selected and focused in the UI. Native chrome actions
can leave focus in chrome. The production Popup link also calls
`runtime.openOptionsPage()`, which may select another Options tab without
changing Classic's protocol target. The old same-handle shortcut skipped the
window-selection command at those boundaries.

`selectLiveWindow()` and `Page.front()` now accept `{ reselect: true }`.
The toolbar helpers use it before opening the real Popup and before importing
after dismissal. Each explicit request sends one Classic Switch To Window
command, including when the protocol target is unchanged. It then runs the
existing Options-settle guard before clicking. Other callers keep the existing
default same-handle shortcut.

The correction retains native Escape, the owned-window/PID checks, one trusted
Search click, original file-change and import-commit assertions, fresh Popup
documents, stale snapshot/row checks and the production Options link. There is
no timeout increase, retry, DOM focus override or additional synthetic action.
All extension runtime files, dependencies and version **5.4.14** are unchanged.

[WebDriver contexts](https://w3c.github.io/webdriver/#contexts) distinguish the
protocol target from the OS window and define Switch To Window as the explicit
selection command. [runtime.openOptionsPage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/openOptionsPage)
describes the native extension operation exercised by the production link.

## Verification

The exact official Developer Edition **158.0b2**, build ID
**20260930090528**, and geckodriver **0.37.1** were used locally with headed
Xvfb/Openbox and **persistent unsigned installation**, matching the CI browser,
driver and installation mode.

| Check | Observed result |
| --- | --- |
| Pristine base, scenario 29 | Failed with the same visible-but-unfocused preflight as CI |
| Patched scenario 29 | Passed both Reads and Rows lifecycle branches |
| Native scenarios 30, 31 and 61 | Passed |
| Root `npm run check` | 2193/2193 Node tests; extension validation and all 70 contrast checks passed |
| Focused selection/import/native-window helpers | 22/22 passed |
| Scenario inventory | 62, unchanged |

In both patched imports, the preflight measured `focused: false` before
reselection and `focused: true` afterward, with a trusted mouse event and
Search active. Both trusted file changes, stored imports and reopened toolbar
documents passed. This is a native red/green reproduction on the pinned browser,
not just a model or the older Playwright Firefox 153 build.

The previous local SIGBUS came from an incompletely extracted `libxul.so`.
Restoring it from the SHA-256-verified official archive and checking every
extracted regular file's size resolved that launch failure. The Firefox 158
runs above supersede the earlier environment limitation.

The complete 62-scenario suite and a new remote CI run have not been executed
with this patch. After applying and pushing, require a completed **62/62**
Firefox Desktop CI result. These desktop results do not establish Android,
macOS or minimum-supported-browser acceptance.
