# Worker error diagnostics 5.5.2

The three message operations now use independent identifiers: `close_current_tab`,
`record_block` and `record_redirect`. A recorded async refusal still passes
through the existing boundary; it does not imply that the entire background
process crashed. Statistics keeps its existing handling of internal storage
failures. Firefox's confirmed-close reply and Chromium's existing close path
retain their browser-specific behavior.

Global `error` events may add `location: { module, line }` only when the filename
exactly equals `runtime.getURL(path)` for a path in the fixed catalog in
`telemetry/errorLocation.js`. Module identifiers are fixed code labels, and line
must be an integer from 1 to 100000. Foreign origins, unknown modules, URL query
strings/fragments and malformed locations produce the existing coarse record.
Messages, stacks, URLs, extension UUIDs and user identifiers are never copied.
Global promise rejections keep the existing coarse format; no stack is parsed.

A valid global worker error adds `:at:<module>:<line>` to its fingerprint.
Different lines stay separate through the daily bucket, retries, raw storage,
daily aggregation, the dashboard fingerprint and JSON/CSV export. A missing
location preserves the old fingerprint exactly. The module catalog includes
the transitive background imports and is checked by tests; keep the receiver
catalog in sync when changing this list.

Delivery uses schema 3 because the receiver strictly validates error keys.
Deploy the accompanying compatible receiver before releasing 5.5.2.
The receiver continues accepting schema 1 and 2, and schema 3 accepts pending
old error shapes without a location. Existing consent, retention, caps,
delivery IDs and duplicate/conflict behavior remain in force.

This is diagnostic attribution, not proof that the historical 5.4.14 failures
were caused by a close race or that every close race has been fixed. The
earlier 5.4.15 duplicate-click guard remains unchanged. Historical errors
cannot acquire source locations retroactively.

Verification covers sanitization and provenance, every imported module,
independent operation names, real store/client retry snapshots and the
receiver's validation/ingestion/aggregation/reporting contract. Native device
checks remain necessary for a reported browser-specific failure.
