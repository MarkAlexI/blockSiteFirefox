# Rule Lists

Rule Lists were introduced in BlockDistraction 4.9.0 and become full blocking profiles in the 5.0.0 line. Exactly one Rule List profile is active during normal blocking. A target is stored once, while each profile can keep an independent Always, Schedule, or Daily Limit assignment for that target.

## Data model

Blocking rules, Rule Lists, the active profile ID, and Daily Limit usage are device-local in `storage.local`.

A blocking target owns data that is the same in every profile:

```json
{
  "id": 17,
  "blockURL": "youtube.com",
  "redirectURL": "",
  "category": "social",
  "isWhitelist": false,
  "assignments": []
}
```

Each assignment describes how that target behaves in one profile:

```json
{
  "listId": "list-1",
  "disabledByUser": false,
  "blockingMode": "schedule",
  "schedule": {
    "version": 2,
    "periods": [
      {
        "days": [1, 2, 3, 4, 5],
        "startTime": "09:00",
        "endTime": "17:00"
      }
    ]
  },
  "dailyLimit": null
}
```

The same target can have a different assignment in another profile:

```json
{
  "listId": "list-2",
  "disabledByUser": false,
  "blockingMode": "daily_limit",
  "schedule": null,
  "dailyLimit": { "minutes": 30 }
}
```

URL, redirect, category, and whitelist state belong to the target. `disabledByUser`, `blockingMode`, `schedule`, and `dailyLimit` belong to the assignment.

## Profiles

The built-in profile is General:

```json
{
  "id": "general",
  "name": "General",
  "disabledCategories": []
}
```

Custom profiles use stable IDs such as `list-1`. The active profile is stored separately as `activeRuleListId`.

Only one profile is active at a time. General is the default profile when no valid custom profile is selected. It is not an always-on layer above Work, Study, or other profiles.

A target may have assignments in General and one or more custom profiles at the same time. Only the assignment that belongs to the active profile participates in normal activation.

For example:

```text
General
  youtube.com -> Always

Work
  youtube.com -> Schedule 09:00-17:00

Study
  youtube.com -> Daily limit 30 min
```

When Study is active, the General and Work assignments do not affect YouTube.

## Category Blocking

Category describes the target itself. For example, YouTube can remain `social` in every profile.

The enabled or disabled state of a category belongs to the profile:

```json
{
  "id": "list-2",
  "name": "Study",
  "disabledCategories": ["news", "entertainment"]
}
```

The Category Blocking section always edits the active profile. Counts are also calculated only from targets that have an assignment in that profile.

Legacy global `settings.disabledCategories` is copied into General during migration. New custom profiles start with every category enabled. New runtime code uses the profile-scoped category state.

## Activation

Outside Focus Session, activation follows this order:

1. Ignore whitelist targets in blacklist DNR generation.
2. Read only the assignment for `activeRuleListId`.
3. Require that assignment to be enabled.
4. Apply the active profile's category state.
5. Evaluate that assignment's Always, Schedule, or Daily Limit mode.
6. Add at most one DNR rule for the target.

Assignments from inactive profiles do not participate in the result.

Focus Session keeps its existing higher priority. In blacklist Focus mode, an active Focus Session activates blacklist targets regardless of profile assignment, category state, schedule, or remaining Daily Limit budget. When Focus Session ends, normal active-profile behavior resumes.

The one-minute scheduling alarm and expected-vs-current DNR self-healing flow remain unchanged.

## Daily Limits

Daily Limit usage is assignment-scoped with keys such as:

```text
17:general
17:list-2
```

This allows the same target to keep separate budgets in different profiles. Only the Daily Limit assignment in the active profile can accrue usage.

Foreground accounting uses a one-off Page Visibility probe for the matching active tab. Hidden pages and failed visibility probes are not charged, and unknown gaps longer than 90 seconds are not charged.

The URL matcher used for Daily Limit attribution preserves BlockDistraction's flexible DNR-style pattern semantics. Partial domain-label rules such as `yout` can match `m.youtube.com`, while path rules retain prefix behavior.

## Adding an existing target to another profile

The target is stored once. If `youtube.com` already exists in Work and the user adds the same target while Study is active, BlockDistraction adds a Study assignment instead of creating a second target.

The existing target-level URL, redirect, and category are preserved. The new Study assignment receives its own enabled state and the blocking mode selected while it is added.

Rule Packs use the same model. New targets receive an assignment in the active profile. Existing matching targets receive a new assignment in the active profile. A Rule Pack schedule applies only to assignments created by that import.

## Editing and deletion

The Options table always represents the active profile, so it does not need a separate List column. Editing a row changes the active profile assignment for that target.

If a target also exists in other profiles, removing it from the active profile removes only that assignment. If the active profile contains the target's only assignment, deleting it deletes the target.

Deleting an entire custom profile is different: any target used only in that profile is preserved by moving its removed assignment configuration to General. Targets that already have assignments elsewhere simply lose the deleted profile assignment.

Strict Mode and password protection continue to protect assignment removal and target deletion.

Whitelist rules remain global and are shown in every profile view.

## Migration

The 5.0.0 migration accepts previous BlockDistraction rule representations:

- rules without Rule List data become one General assignment;
- legacy `listId` becomes one assignment;
- RC multi-membership `listIds` becomes one assignment per list;
- old root `disabledByUser` state is copied into every migrated assignment;
- old root `blockingMode`, `schedule`, and `dailyLimit` configuration is cloned into every migrated assignment;
- existing canonical `assignments` are preserved;
- whitelist rules normalize to one General/Always assignment;
- missing or invalid active profile state falls back to General;
- legacy global disabled categories are copied to General.

After migration, legacy root fields `listId`, `listIds`, `disabledByUser`, `blockingMode`, `schedule`, and `dailyLimit` are removed so `assignments` is the only profile-behavior source of truth.

Daily Limit usage is migrated from rule-level keys to assignment-level keys so an update does not silently grant a fresh daily budget.

## Import and export

Exports contain canonical targets with `assignments`, Rule List profile definitions, and `activeRuleListId`. Accumulated Daily Limit usage is never exported.

Older exports remain importable. Imported profile IDs and names must be valid and unique, each assignment must reference an imported profile, and a target can have at most one assignment per profile. Password data remains excluded from import/export.
