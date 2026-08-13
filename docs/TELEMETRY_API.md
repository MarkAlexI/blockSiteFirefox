# BlockDistraction telemetry API contract

Client endpoint:

```text
POST https://blockdistraction.com/api/telemetry
Content-Type: application/json
```

Telemetry is disabled by default. The extension does not create telemetry buckets until the user explicitly enables technical data sharing in the Options page.

## Current request: schema v2

```json
{
  "schemaVersion": 2,
  "sentAt": "2026-08-12T12:00:00.000Z",
  "context": {
    "extensionVersion": "4.8.4",
    "browser": "firefox",
    "browserMajor": 153,
    "platform": "mobile",
    "os": "android",
    "locale": "es-es",
    "access": "pro",
    "installationAge": "90d_plus"
  },
  "batches": [
    {
      "date": "2026-08-12",
      "deliveryId": "8c9c4a53-6f30-4c1f-a3d0-fad9ab52b7fd",
      "counters": {
        "rule_created": 3,
        "focus_started": 1
      },
      "errors": [
        {
          "source": "dnr",
          "code": "sync_failed",
          "operation": "update_dynamic_rules",
          "errorName": "error",
          "fingerprint": "dnr:sync_failed:update_dynamic_rules:error",
          "count": 2
        }
      ]
    }
  ]
}
```

`deliveryId` is a random UUID for one prepared delivery snapshot. It is not an installation or client identifier. The same ID is reused only while retrying that exact unacknowledged snapshot. After acknowledgement, the snapshot and its ID are removed. If newer events remain in the same UTC-day bucket, the next delivery gets a new ID.

This makes schema-v2 delivery idempotent without introducing a persistent identifier. A server that has already accepted a `deliveryId` must acknowledge an identical retry without adding its counters or errors again. If the same ID arrives with different content, the first accepted payload wins and the conflict is recorded as delivery-health telemetry on the server.

The client never sends an installation identifier, rule content, browsing data, URLs, email addresses, license keys, passwords, raw error messages, filenames, or stack traces.

The schema-v2 counter allowlist currently includes rule, category, Focus Session, diagnostics, and feedback interaction counters. Feedback counters are limited to `feedback_prompt_shown`, `feedback_review_clicked`, `feedback_support_clicked`, and `feedback_dismissed`; they contain no prompt content or free-form values.

The coarse `context` is captured with the local UTC-day bucket when that bucket is first created. If queued days have different captured contexts, the client sends separate requests so each day keeps the context recorded at collection time. Legacy buckets without stored context use the current coarse context as a delivery fallback.

## Backward compatibility

The server accepts schema v1 requests from already released extension versions. Schema v1 batches have no `deliveryId`, so exact retry deduplication is not possible for those legacy deliveries. New Firefox clients starting with 4.8.4 send schema v2.

## Response

Accept all batches:

```json
{
  "ok": true,
  "acceptedDates": ["2026-08-12"]
}
```

An idempotently accepted retry may additionally report:

```json
{
  "ok": true,
  "acceptedDates": ["2026-08-12"],
  "duplicateDates": ["2026-08-12"]
}
```

If a delivery ID conflict is detected, the server keeps the first accepted payload, records the conflict in server-side delivery health, and acknowledges the date so the client does not retry a corrupted snapshot forever.

Any `2xx` response with `ok !== false` is treated as successful. If `acceptedDates` is absent, every date in the request is considered accepted.

`4xx`, `5xx`, network failures, invalid server responses with `ok: false`, and timeouts keep the local queue intact and activate exponential backoff. The queue is retained for at most seven days.

## Server-side validation requirements

The Firebase function should:

- accept only `POST`;
- require `Content-Type: application/json`;
- accept schema v1 for backward compatibility and schema v2 for idempotent delivery;
- require a valid UUID-v4 `deliveryId` on every schema-v2 batch;
- reject duplicate delivery IDs inside one request;
- reject unknown top-level fields if practical;
- cap the request size;
- allow only known context enum values, including `firefox` for the Firefox build;
- allow only known counter names;
- allow only identifier-shaped error fields;
- reject URLs, email-shaped strings, license-key-like strings, raw stack traces, and arbitrary error messages;
- rate-limit abuse without requiring a persistent client identifier;
- atomically persist unique raw schema-v2 deliveries and update daily aggregates;
- make identical retries no-ops for product counters and errors;
- return `200` or `202` with `{ "ok": true }` after durable acceptance.

The HTTP layer will naturally see request metadata such as the source IP. The application payload intentionally contains no persistent user or installation identifier.
