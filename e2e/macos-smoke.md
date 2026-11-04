# macOS native browser acceptance

The Firefox E2E workflow runs an additional **24-scenario smoke subset** on
standard `macos-15` (Apple Silicon/arm64) and `macos-15-intel` (x64) runners.
Both run automatically on the existing push/PR/manual triggers. The original
Linux core, overdue and upgrade groups and their assertions remain unchanged.
The existing `e2e` required check now needs Linux and **both** Mac jobs to succeed.

## Browser and installation

`setup-macos-firefox.sh` downloads Firefox Developer Edition **158.0b2** and
geckodriver **0.37.1**, matching the existing Linux browser/driver versions.
Both Mac downloads contain universal binaries. Their SHA-256 values are pinned
in the script and checked before extraction or mounting. The runner records the
actual Node architecture and refuses an arm64/x64 mismatch before browser setup.

Developer Edition is intentional: the harness installs an unsigned, persistent
add-on in its disposable Firefox profile and exercises real restarts. The image's
preinstalled release Firefox cannot replace that installation mode. Signature
preferences and the loopback test CA stay in the disposable browser profile.
Homebrew OpenSSL 3 is selected explicitly because the fixture's certificate
generation requires `req -addext`, which the system LibreSSL does not provide.

The runtime is built from committed HEAD with `npm run package:amo`, then
extracted as `BD_EXTENSION_PATH`. No CI/test files enter the runtime package.
This is a packaged-source test, not verification of AMO's signed store bytes.

## Coverage

The smoke group selects existing scenario bodies without modifying assertions,
deadlines, retries, browser APIs or product behavior:

| IDs | Coverage |
| --- | --- |
| 01–06 | Concurrent rules, stale edits, import/delete, native DNR, durable usage recovery and migration after restart |
| 07–08 | Actual foreground Daily Limit accounting, deadline blocking and background-tab pause |
| 09–13 | Free/Pro/Legacy, native license consent, logout and verification recovery against the loopback fixture |
| 18–20 | Options/Popup reader consistency, spent budgets and expired-day recovery after restart |
| 21–25 | Stale schedule/category edits and native scheduled Focus start, restart and completion |
| 27–28 | Native keyboard focus and draft retention in Options and the Popup reader |
| 46 | Nested HTTP frame accounting and real top-level blocking |

`verify-macos-result.mjs` requires all 24 unique IDs to have passed, started
their bodies and finished cleanup. The report must identify macOS and the
matrix's actual architecture. A blocked/unfinished result cannot pass acceptance.
An unfiltered local run still selects the full suite; this subset is an additional
platform job, not a replacement for Linux coverage.

## Limits and evidence

Popup coverage here uses the packaged Popup as a tab, not the native action
panel lifecycle. Audio, native browser shortcuts, idle/cold-background probes,
version upgrades, process interruption, OS sleep/resume, live midnight/DST and
signed-store parity remain separate acceptance tasks. Scheduled Focus coverage
does not establish active-Focus preservation through a version update.

`results.json` includes actual Firefox capabilities and platform/architecture.
`macos-environment.json` records the runner OS/image and Node version. Results
and runtime provenance are retained for seven days. On failure/cancellation,
screenshots, browser/network logs and state evidence are retained for three days;
successful jobs do not upload their large screenshot directories.

The initial macOS run must still be executed and inspected on GitHub. Local
unit checks and `--list` only verify the harness/selection, not macOS behavior.
Extension version **5.5.9** is unchanged because this change affects only CI,
test selection, acceptance checks and developer documentation.

Sources:

- [Standard public-repository runners](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
- [GitHub Actions billing and artifact storage](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Firefox signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Mozilla Firefox 158.0b2 SHA256SUMS](https://archive.mozilla.org/pub/devedition/releases/158.0b2/SHA256SUMS)
- [geckodriver 0.37.1 release](https://github.com/mozilla/geckodriver/releases/tag/v0.37.1)
