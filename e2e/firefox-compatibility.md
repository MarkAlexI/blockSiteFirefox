# Firefox Desktop compatibility, 2026-11-07

These groups add native coverage for Firefox 128.0 ESR and ESR 115.31.0. They do not certify the
manifest's declared Firefox Desktop 113 or Firefox Android 120 minimums.

## Observed installation boundary

On Linux x64, stock Firefox 113.0 / geckodriver 0.33.0 rejects the actual signed
AMO 5.6.0 XPI and the unsigned runtime ZIP before any scenario can execute:

```text
Reading manifest: Error processing browser_specific_settings.gecko:
Unexpected property "data_collection_permissions"
```

This is an installation failure, not a failed Node test, unavailable browser,
or proof that the extension's JavaScript ran. Do not remove the field from the
test package and call the result acceptance of the production package.

Mozilla bug 1757293 changed unknown Gecko manifest properties from errors to
warnings in Firefox 128. Bug 1996829 later backported this to ESR 115.31.0.
A separate stock ESR 115.31.0 probe installs the signed 5.6.0 XPI, grants host
access through the native prompt and checks real blocking before and after a
browser restart. The `esr115` group additionally reuses all seven native bodies
below. ESR 115 cannot observe `browsingContext.userPromptOpened`; the group
subscribes to `log.entryAdded` and does not include scenarios that require the
unavailable event. Modern groups keep both subscriptions.

The declared minimums are deliberately unchanged by this tests-only patch.
Raising Desktop to 128 would also exclude the ESR 115.31 branch. Declaring a new
minimum still needs a compatibility decision: regular Firefox 116–127 does not
contain ESR 115.31's backported fix. Android 120 has
not been executed here. Do not treat the new green job as release acceptance
of either declared minimum.

## Target and scope

- Firefox **128.0 ESR** and **115.31.0 ESR**, Linux x64, real headed browsers under Xvfb.
- geckodriver **0.35.0**, pinned Selenium and fflate from `e2e/package-lock.json`.
- Disposable native profile, persistent unsigned AMO runtime, the normal ESR
  developer preference for signature enforcement in that profile only.
- Normal certificate validation with the existing loopback HTTP/TLS fixture CA.
- The ordinary release 128.0 also passed native scenario 01 with the signed AMO
  5.6.0 XPI, independently of the ESR unsigned-package run.

| Existing ID | Acceptance |
| --- | --- |
| 01 | Two Options callers, rules, actual DNR redirects |
| 05 | Durable usage remap recovery after browser restart |
| 06 | Mixed v1 usage migration after restart |
| 07 | Actual foreground accounting and native limit alarm |
| 21 | Skip/Undo across views, stale A-B-A actions and restart |
| 25 | Original schedule alarm, one handled occurrence, Focus completion across restart |
| 46 | Native nested frames, parent accounting and real navigation blocking |

These bodies are reused without changed deadlines, synthetic alarm dispatch,
fake clocks, forced JS clicks or test retries. Scenario 25 has sound disabled
by its existing fixture; it is not an audible-completion acceptance test.
Scenario 46 requires headed mode and normal native desktop focus handling.

## Test harness differences

`BD_GECKODRIVER_LEGACY=1` omits the newer `--allow-system-access` flag, which
geckodriver 0.35 does not accept. Default modern-browser runs retain the flag.
In a native probe, geckodriver 0.37.1 / Firefox 128 rejected the add-on install
command; the pinned 0.35 pair executes it. A documented version range alone
does not establish compatibility of every driver command.

Only the compatibility groups supply the live probe as BiDi
`browsingContext.create.referenceContext`. Without this explicit target, the
native Firefox 128 run failed after Focus cleanup (`tabBrowser is undefined`). The
reference is reset when a new browser process launches. This chooses the owned
test window; it does not change the extension, repeat an action, move a deadline
or alter multi-window targeting in the modern suite.

For ESR 115, the fixture opens the real onboarding page, selects its owned tab,
clicks Activate Full Protection with WebDriver and accepts the browser's native
host-permission button with Space. A background tab can leave a native request
queued; selecting the sender tab resolves the exploratory probe's earlier stall.
Old XUL buttons dispatch a trusted `command` event for keyboard activation;
HTML buttons dispatch `click`. Both require `isTrusted=true` and keyboard detail 0.
The fixture never pre-grants access and fails if permission is missing after a
restart, rather than requesting it again. This flow is isolated to `esr115`.

The shared Add-rule helper selects the existing `tr.rule-editor-row` class.
Firefox 115 cannot parse the previous `:has(.save-btn)` test selector. This is
a selector for the same production editor row, without a runtime DOM change.

## Local run

Use Node 22+, OpenSSL and headed Linux dependencies from the workflow.
Set `BD_FIREFOX_BINARY` to the extracted 128.0 ESR binary and
`BD_GECKODRIVER` to the extracted 0.35.0 executable. From `e2e/`:

```bash
npm ci
BD_E2E_GROUP=compatibility BD_GECKODRIVER_LEGACY=1 xvfb-run -a npm run test:headed
node verify-compatibility-result.mjs
```

For ESR 115.31, point `BD_FIREFOX_BINARY` to that ESR binary, keep geckodriver
0.35.0, and use `BD_E2E_GROUP=esr115` for both the run and verifier.

The workflow downloads pinned official archives, checks browser and driver SHA-256 hashes,
builds and unpacks the tracked AMO package, runs all seven scenarios and
verifies `results.json`. The final `e2e` job requires both compatibility matrix jobs alongside all
existing Linux groups and both macOS architectures. A new GitHub run is still
required after committing the patch.

The verifier rejects wrong browser/driver/release, headless or temporary
installation, missing/duplicate IDs, unstarted bodies, failed cleanup and
unfinished or partially passing reports. Node tests include negative controls
for those cases.
The ESR 115 verifier also rejects absent/pre-granted access, synthetic activation,
incorrect observation metadata and permission loss hidden by another grant.

## Primary references

- https://bugzilla.mozilla.org/show_bug.cgi?id=1757293
- https://bugzilla.mozilla.org/show_bug.cgi?id=1996829
- https://firefox-source-docs.mozilla.org/testing/geckodriver/Support.html
- https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
- https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/
- https://support.mozilla.org/en-US/kb/root-certificate-expiration
