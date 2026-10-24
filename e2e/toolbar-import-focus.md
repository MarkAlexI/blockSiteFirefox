# Toolbar import focus — 2026-10-24

## Observed CI failure

Base `71b5775b390e4e0d9de8055f8309692ffa111c6a`,
[run 40091514151](https://github.com/MarkAlexI/blockSiteFirefox/actions/runs/40091514151),
reported **61 passed / 1 failed / 0 blocked**, with all 62 bodies started.
The first pointer-only correction did not resolve scenario 29. Developer
Edition **158.0b2**, geckodriver **0.37.1**, persistent unsigned installation
and Openbox produced this actual preflight state after closing the toolbar:

```json
{
  "before": { "focused": false, "visibility": "visible", "active": "__bdOpenToolbar" },
  "after": {
    "focused": false, "visibility": "visible", "active": "search-input",
    "pointer": { "trusted": true, "type": "mouse" }
  }
}
```

The guard failed before file selection. An active Search element and a trusted
WebDriver pointer event did not establish document focus. The artifact had no
native active-window measurement, so it does not establish which OS window was
active or whether Gecko retained a stale internal focus state.

[WebDriver contexts](https://w3c.github.io/webdriver/#contexts) explicitly allow
commands regardless of OS window focus. Selecting a current handle is not a
desktop activation. [MDN hasFocus](https://developer.mozilla.org/en-US/docs/Web/API/Document/hasFocus)
also distinguishes the active element from actual document focus. Missing
desktop activation is a demonstrated harness gap; its causal connection to
the exact Firefox 158 failure remains to be confirmed by CI.

## Correction

After the genuine toolbar document is destroyed, the headed Linux fixture:

1. Selects the existing Options tab using the existing WebDriver path.
2. Resolves exactly one normal X11 client owned by the session's
   `moz:processID`. A foreign client, popup, missing owner or multiple matching
   browser windows cannot be selected implicitly.
3. Rechecks ownership, requests one `xdotool windowactivate --sync` EWMH
   activation, then verifies `_NET_ACTIVE_WINDOW` and ownership again.
4. Performs the existing single WebDriver click on Search and requires its
   trusted pointer event, visible/focused document and correct active element.
5. Runs the existing file selection, trusted change-event checks, import and
   toolbar close/reopen assertions.

Commands use the existing native backend's 3-second command budget. Activation
is not retried. Headed Linux requires X11; other platforms and headless runs
retain their prior WebDriver path and content-focus checks. This correction
does not establish native acceptance on Windows, macOS, Wayland or Android.
CI already installs `xdotool`, `xprop` and Openbox, so no workflow or dependency
change is needed. [xdotool documentation](https://github.com/jordansissel/xdotool/blob/main/xdotool.pod)
describes EWMH activation and waiting for completion.

`popupNativeEvidence.toolbar-import-focus-Reads` and `-Rows` now include a
`desktop` object with backend, process ID, X11 window ID and native active IDs
before/after activation. Focus evidence is recorded **before assertions**, so
an unfocused document still leaves structured diagnostics. Existing
`toolbar-import-selection-Reads` and `-Rows` retain native file-event details.

Runtime prompt guards, Search drafts, original scenario deadlines, DNR checks,
distinct Popup documents and stale callback assertions are unchanged. There
is no DOM focus override, synthetic event, fallback activation or scenario
retry. Extension version remains **5.4.14**.

## Verification and limits

- `npm run check`: **2192/2192** Node tests, extension validation and all 70
  palette contrast checks passed.
- **17/17** focused helper tests passed. They cover ownership, ambiguity,
  replaced clients, refused activation, invalid native state, one action,
  failure propagation, preserved drafts and evidence on rejected focus.
- The standard headed Selenium runner passed scenarios **29, 30 and 61** on
  Firefox **153.0** with geckodriver **0.37.1**, Xvfb/Openbox and temporary
  installation. The local binary is Playwright's Ubuntu 22.04 Firefox build;
  Selenium, not Playwright, drives the installed extension.
- A separate controlled native run activated another owned test application's
  window after each toolbar dismissal. On the pristine base, both imports
  completed while that other application was still the native active window.
  With this patch, both imports ran with the Firefox-owned X11 client active;
  trusted pointer/file events, fresh Popup documents and both commits passed.

The controlled run proves the missing OS activation and its correction. It
does **not** reproduce the CI `hasFocus() === false`: local Firefox 153 returned
true even with the other application active. Both complete scenario bodies
passed locally, so this is not a red/green reproduction of the full CI failure.

The exact official Firefox 158.0b2 archive was downloaded and its workflow
SHA-256 verified, but its launcher terminated with SIGBUS (return code -7)
even for `--version`. Thus neither full Firefox 158 acceptance nor persistent
unsigned installation was verified locally. The full suite was not run here;
the earlier local Firefox 153 limitation in scenario 31 is not changed.

After applying and pushing, require **62/62** in the pinned headed Firefox CI.
If document focus still fails with a verified native foreground window, the
recorded desktop/content states narrow the remaining investigation to Gecko's
focus handling rather than hiding the failure with weaker assertions.
