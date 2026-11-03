# Post-update Options investigation — 5.5.9

## Observed result

5.5.8 detected a real post-update failure in Kiwi and displayed recovery guidance.
Reloading the page did not restore the rule view; restarting the browser did.
The same symptom had also been reported in desktop Chrome. Neither an Android-
only browser limitation nor data loss has been established.

The 5.5.8 Chromium and Firefox Desktop CI runs passed, including native update
preservation. Their scenario opened current Options after the update but did not
reload and inspect the retained old tab. The 5.5.9 assertions have not yet run in
native CI. Development-package updates do not prove store-delivered Android
update behavior.

## Local report

While the warning is visible, **Copy Report** works in the independent classic
script. It does not request a report from the background process. If clipboard
access fails, the read-only report stays visible for manual copying.

One failure snapshot is stored under `bdOptionsRecoveryFailureV1` in the Options
origin's DOM local storage, outside the rules and credentials stores. A healthy
restart does not erase it. Normal **Privacy & Technical Data → Diagnostics →
Generate Report** includes `optionsRecovery.current` and `optionsRecovery.lastFailure`.
**Clear History** removes that local snapshot after the normal clear action succeeds.
Local-storage failures do not prevent in-memory copying. Reports are not sent
automatically; the existing telemetry consent and protocol are unchanged.

The schema includes build versions, extension URL schemes, stage states, a failure
time and fixed error codes. It never stores rule contents, hostnames, extension
IDs, licenses, user IDs, raw error messages or stacks. Persisted content is size
limited and reconstructed through the same allowlist before use.

| Report field | Interpretation |
| --- | --- |
| `module: pending` at deadline | The module did not reach its constructor; inspect imports/bootstrap next. |
| `setup: pending` | Construction or initial event/UI setup did not finish. |
| `access: pending` | The credential/access read did not return. |
| `rules`, `lists` or `usage: pending` | That read did not settle before the watchdog; it is not an empty saved list. |
| `connection: error` / `no_receiver` | Runtime messaging reported no receiving endpoint. This alone does not identify why. |
| `connection: error` / `rules_health_forbidden` | A health reply explicitly rejected the sender. Sender security is unchanged. |
| `connection: error` / `rules_connection_timeout` | The read-only health request did not answer within its existing deadline. |
| `render: error` | Reads completed, but rendering threw. Raw exception text is deliberately excluded. |
| `current: ready` with `lastFailure` | The view has recovered; inspect the retained failure time and stages. |

A pending stage is evidence of where progress stopped, not proof that the browser
or the extension caused it. Stale refresh results cannot replace current stage
states. No read timeout retries a mutation or resets saved state.

## Native/device acceptance

1. Keep Options open with existing rules, update the actual installed extension,
   and record whether the browser retains or closes the old tab.
2. If retained, reload that same tab. Confirm saved rules render and a normal edit
   can be saved. Also reopen Options through Popup and check the same behavior.
3. If the warning appears, copy its report before restarting. The snapshot should
   also appear in normal diagnostics after restart; record browser build and the
   update source alongside it.
4. Verify genuine empty-rule storage still renders an empty, usable view. Never
   clear rules or remove the extension as a recovery step.

Scenario 67 automates retained-tab reload when supported and fresh view plus
rule-toggle acceptance in native desktop fixtures. It records browser closure of
the old view instead of silently substituting a new tab. Store auto-update on
Kiwi/Chrome Android still needs device acceptance.
