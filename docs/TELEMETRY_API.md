# BlockDistraction telemetry API contract

Client endpoint:

```text
POST https://blockdistraction.com/api/telemetry
Content-Type: application/json
```

Telemetry is disabled by default. The extension does not create telemetry buckets until the user explicitly enables technical data sharing in the Options page.

## Request

```json
{
  "schemaVersion": 1,
  "sentAt": "2026-08-07T12:00:00.000Z",
  "context": {
    "extensionVersion": "4.8.1",
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
      "date": "2026-08-07",
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

The client never sends an installation identifier, rule content, browsing data, URLs, email addresses, license keys, passwords, raw error messages, filenames, or stack traces.

The schema-v1 counter allowlist currently includes rule, category, Focus Session, diagnostics, and feedback interaction counters. Feedback counters are limited to `feedback_prompt_shown`, `feedback_review_clicked`, `feedback_support_clicked`, and `feedback_dismissed`; they contain no prompt content or free-form values.

The coarse `context` is captured with the local UTC-day bucket when that bucket is first created. If queued days have different captured contexts (for example, because the extension was updated or access changed before delivery), the client sends separate schema-v1 requests so each day keeps the context recorded at collection time. Legacy 4.8.0 buckets without stored context use the current coarse context as a delivery fallback.

## Response

Accept all batches:

```json
{
  "ok": true
}
```

The endpoint may also acknowledge only selected dates:

```json
{
  "ok": true,
  "acceptedDates": ["2026-08-07"]
}
```

Any `2xx` response with `ok !== false` is treated as successful. If `acceptedDates` is absent, every date in the request is considered accepted.

`4xx`, `5xx`, network failures, invalid server responses with `ok: false`, and timeouts keep the local queue intact and activate exponential backoff. The queue is retained for at most seven days.

## Server-side validation requirements

The Firebase function should:

- accept only `POST`;
- require `Content-Type: application/json`;
- require `schemaVersion === 1`;
- reject unknown top-level fields if practical;
- cap the request size;
- allow only known context enum values, including `firefox` for the Firefox build;
- allow only known counter names;
- allow only identifier-shaped error fields;
- reject URLs, email-shaped strings, license-key-like strings, raw stack traces, and arbitrary error messages;
- rate-limit abuse without requiring a persistent client identifier;
- write only aggregated operational data needed for reliability analysis;
- return `200` or `202` with `{ "ok": true }` after durable acceptance.

The HTTP layer will naturally see request metadata such as the source IP. The application payload intentionally contains no persistent user or installation identifier.
