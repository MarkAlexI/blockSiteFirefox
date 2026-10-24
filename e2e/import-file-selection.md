# Import file selections (test-only correction)

The Chromium 5.4.13 run on `f1e10b9ed833462cb7442cfff60d47194e22bc2d`
[40067365051](https://github.com/MarkAlexI/blockSiteExtension/actions/runs/40067365051)
completed with 58 passed / 1 failed. Scenario 61 failed at
`second file held before confirmation`: `reads: 0`, `readStarted: false`, the
previous success message and a selected file remained. Native startup restore
passed in that run.

The upload helper wrote different backup contents to `reader-backup.json`.
The intentionally ignored selection remained selected, as the scenario requires.
Writing the next backup to that same path did not create a different selection.
In Blink 151.0.7922.34, selecting that path again emitted `cancel` instead of
another `input`/`change`. Local DOM/API-model execution of the original complete
scenario reproduced the same failing stage and state as CI. This is a fixture
selection issue, not evidence that the import guard or delayed-read handling
failed in production.

## Correction

`importBackup(page, backup, { filename, reuse })` keeps the original default
filename for existing callers. Scenario 61 gives invalid, first, ignored and
later backups distinct names. For its explicit retry it selects
`later-backup.json` again with `reuse: true`, without rewriting its bytes or
modification time. The production import handler releases the accepted input
before this retry. The upload helper does not clear it or dispatch an event.

The scenario records real `input`, `change` and `cancel` events in capture
phase, before the production handler clears its accepted File snapshot. It
requires five actual changes with these names:

1. `invalid-backup.json`
2. `first-backup.json`
3. `ignored-backup.json`
4. `later-backup.json`
5. `later-backup.json` (the unchanged file)

The ignored selection must really emit `change` while producing no additional
read or mutation. Its filename must survive the older import's completion.
Existing keyboard, focus/draft, password, one-intent, saved-state and persistent
feedback checks remain. Deadlines, retries and runtime files are unchanged.

## Verification (2026-10-24)

- Four Node checks exercise the actual upload-helper method with real temporary
  files: default JSON upload/order, distinct paths/content, unchanged-file reuse
  including modification time, and failed write propagation. Each variant gives
  2 passed / 2 failed on the original helper, then 4/4 after the correction.
- Blink 151.0.7922.34, actual DOM/File/input/keyboard and production UI methods
  with modeled extension transport/storage/confirm: original scenario 61 fails
  at the CI stage after `input,change` three times then `cancel`; corrected
  scenario passes with five `input,change` pairs. This is DOM/API-model evidence,
  not installed Chromium acceptance.
- Native Firefox 153.0, geckodriver 0.37.0, Linux headless, temporary extension
  installation: corrected scenario 61 passed, 1 body started, 0 failed/blocked.
  All five recorded `change` events were trusted; password/worker/storage paths
  and the unchanged-file retry completed.
- Full checks on 5.4.14: Chromium 2202/2202, Firefox 2175/2175, no skips or
  failures. Both palette checks pass 70/70.
- Installed Chromium execution remains locally blocked by AF_UNIX EPERM; a new
  native CI run is required. OS chooser cancellation, screen-reader speech,
  Android and other unsupported platform coverage are not claimed.

[HTML file-picker behavior](https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file))
and [MDN cancel](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/cancel_event)
allow unchanged selections to end without a fresh change. The observed protocol
behavior is recorded separately from that contract.

Focused browser reruns from `e2e/`:

- Chromium: `npx playwright test accessibility.spec.mjs --grep 'Backup import has persistent safe feedback'`
- Firefox: `node runner.mjs --filter=61`
