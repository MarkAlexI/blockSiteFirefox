# Toolbar import focus — 2026-10-24

## Observed failure and hypothesis

At base `d866a982340e72cd756b69973adc3b24c90297b7`,
[run 40073052134](https://github.com/MarkAlexI/blockSiteFirefox/actions/runs/40073052134)
reported **61 passed / 1 failed / 0 blocked**, with 62 scenario bodies started.
Scenario 29 failed waiting for an Options import while the toolbar was closed:
the stored rule remained `toolbar-before.bd-e2e.test`. Its artifact has no page
or network errors. The run used headed Developer Edition **158.0b2** and
geckodriver **0.37.1**, with persistent unsigned installation.

The test previously closed Gecko's chrome panel with native Escape, selected
the existing Options handle, then uploaded directly to the hidden file input.
Selecting an already-current handle need not produce a new content interaction.
With `strictFileInteractability: false`, the
[WebDriver file-upload algorithm](https://w3c.github.io/webdriver/#element-send-keys)
skips the normal keyboard-interactability/focus path before setting files and
dispatching input/change. This leaves a gap between the test's automation and
the content interaction preceding a user's backup selection.

Focus is therefore a plausible missing test precondition, **not an established
root cause of the 158 CI failure**. That artifact did not record focus at file
selection, and the exact failure has not been reproduced locally.

## Test change and evidence

After asserting that the genuine toolbar document was destroyed, the Firefox
branch selects Options and performs exactly one WebDriver pointer click on
the existing Search input. It verifies a trusted pointer event, visible and
focused content, and that Search is the active element before importing.
The click does not type into Search or alter its draft.

Each file selection records its trusted change event, selected filename,
document focus, active element and import status. An unfocused or synthetic
selection fails explicitly. Evidence appears in `popupNativeEvidence` as:

- `toolbar-import-focus-Reads` and `toolbar-import-focus-Rows`: before/after
  focus, visibility, active element, pointer trust/type and Search draft.
- `toolbar-import-selection-Reads` and `toolbar-import-selection-Rows`: native
  file-change details and immediate import status.

The original import-commit deadline, real toolbar close/reopen, distinct Popup
documents, stale snapshot/row callback checks and DNR assertions remain in
place. There is no retry, programmatic focus override or synthetic DOM click.
The production prompt/focus guard and all runtime files are unchanged.

## Local verification and limits

- `npm run check`: **2181/2181** Node tests, extension validation and all 70
  palette contrast checks passed.
- Six helper model tests cover one pointer action, Search draft preservation,
  untrusted input, hidden/unfocused/wrong-target content and click failure.
  These tests validate helper behavior; they do not reproduce the CI failure.
- The standard headed runner passed scenarios **29, 30 and 61** using native
  Firefox **153.0**, geckodriver **0.37.1**, Xvfb/Openbox and **temporary**
  installation. Scenario 29 observed both trusted mouse clicks, both trusted
  file changes, both committed imports and fresh toolbar documents.
- Unmodified scenario 29 also passed on that local Firefox. Thus this is not
  a native red/green reproduction of the 158 failure.
- Scenario 31 failed at the same `actual background visibility` assertion in
  both the pristine base and patched tree: the document remained visible and
  focused on local Firefox 153. Its assertions were not weakened. The base CI
  on Firefox 158 passed that scenario.

The exact pinned Firefox 158 binary terminated with SIGBUS even for `--version`
in this environment. Firefox 153 rejected persistent unsigned installation;
the passing runs above used temporary installation instead. They establish
native Gecko interaction for the selected cases, not full equivalence with CI
or a passing full suite. The WebDriver file adapter is exercised, not the
operating system file chooser.

After applying and pushing, the full pinned Firefox 158 CI must pass. If 29
still fails, the new focus/selection evidence should distinguish an invalid
interaction context from a later import/prompt failure. Extension version
**5.4.14**, dependencies and scenario deadlines are unchanged.
