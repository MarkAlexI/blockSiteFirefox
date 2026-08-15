# Rule Lists

Rule Lists were introduced in BlockDistraction 4.9.0 as a Pro/legacy organization and control layer for blocking rules. In the 5.0.0 line, Rule Lists use an assignment model: the blocked target is stored once, while each list can keep its own blocking configuration for that target.

## Data model

Rule Lists and blocking rules are device-local and stored in `storage.local`. Rule Lists remain separate from synchronized settings.

A blocking rule owns target-level data:

```json
{
  "id": 17,
  "blockURL": "youtube.com",
  "redirectURL": "",
  "category": "social",
  "disabledByUser": false,
  "isWhitelist": false,
  "assignments": []
}
```

Each `assignments` entry describes how that target behaves in one Rule List:

```json
{
  "listId": "list-1",
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

The same target can have another assignment with different settings:

```json
{
  "listId": "list-2",
  "blockingMode": "schedule",
  "schedule": {
    "version": 2,
    "periods": [
      {
        "days": [1, 3, 5],
        "startTime": "19:00",
        "endTime": "22:00"
      }
    ]
  },
  "dailyLimit": null
}
```

The URL, redirect, category, global enabled/disabled state, and whitelist state belong to the target. `blockingMode`, `schedule`, and `dailyLimit` belong to an assignment.

Whitelist rules remain internally assigned to General with Always mode and are not exposed as custom-list assignments.

## General

The built-in list is:

```json
{
  "id": "general",
  "name": "General",
  "disabled": false
}
```

General is the default context for new rules when no custom list is selected. When a General-only target is added to a custom list, the custom assignment replaces the General fallback rather than keeping General as an invisible always-enabled membership.

If deleting an entire custom Rule List would leave a target without assignments, that target is preserved by moving the removed assignment configuration to General. Deleting a list therefore never destroys targets silently.

## Migration

The assignment migration accepts every earlier Rule List representation used by BlockDistraction:

- rules without Rule List data become one General assignment;
- legacy `listId` becomes one assignment;
- 5.0.0 RC multi-membership `listIds` becomes one assignment per list;
- the old root `blockingMode`, `schedule`, and `dailyLimit` configuration is cloned into each migrated assignment so existing behavior does not change on upgrade;
- whitelist rules normalize to one General/Always assignment.

After migration, legacy `listId`, `listIds`, `blockingMode`, `schedule`, and `dailyLimit` root fields are removed so `assignments` is the only source of truth.

Daily Limit usage is migrated separately from rule-level keys to assignment keys such as `17:list-1`. Existing usage is copied to each migrated Daily Limit assignment so an update does not grant a fresh daily budget.

## Access model

Creating, renaming, toggling, deleting, or assigning a target to a custom Rule List requires Pro or legacy access.

Stored Rule List state is still respected by DNR activation if Pro verification is temporarily unavailable. A transient licensing or network failure must not silently change blocking behavior.

## Activation

Outside Focus Session, the extension evaluates every enabled assignment independently. A target is represented in DNR when at least one of its enabled assignments currently blocks.

For example:

```text
YouTube / Work  - Schedule 09:00-17:00
YouTube / Study - Schedule 19:00-22:00
```

At 10:00, Work can activate the target while Study is inactive. At 20:00, Study can activate the same target while Work is inactive. Only one DNR rule is required for the target.

Pausing Work disables only the Work assignment. A Study assignment for the same target remains eligible.

Focus Session keeps the existing higher priority: an active blacklist Focus Session activates blacklist targets before individual disabled state, category, Rule List, Schedule, or Daily Limit checks.

The one-minute scheduling alarm and expected-vs-current DNR self-healing flow remain unchanged.

## Adding an existing target to another list

The blocked target is stored once. If `youtube.com` already exists in Work and the user adds `youtube.com` while Study is selected, BlockDistraction adds a Study assignment instead of creating a second target or showing a generic duplicate error.

The new Study assignment receives the blocking configuration chosen while adding it. The existing Work configuration is left unchanged.

Rule Packs use the same behavior. New targets receive an assignment in the selected list; matching existing targets receive a new assignment in that list. A Rule Pack schedule applies only to the assignment created by that import.

## Editing and removing assignments

When a specific Rule List is selected, each row represents that list's assignment. Editing the row changes only that assignment's Always, Schedule, or Daily Limit configuration. The list itself is displayed as context rather than as an implicit membership-transfer control.

In a filtered Rule List, the row removal action removes that assignment rather than deleting the underlying target from every list. In All Lists, the normal Delete action remains the target-level delete operation.

If an explicit assignment removal leaves no custom assignment, the current fallback behavior places the target in General. Deleting an entire Rule List also preserves orphaned targets in General.

## Import and export

Exports include canonical rules with `assignments` and the separate `ruleLists` definitions. Accumulated Daily Limit usage is never exported.

Imports created before 4.9.0 or by earlier 5.0.0 release candidates remain valid. Legacy `listId`, `listIds`, and root blocking configuration are normalized to assignments during import.

An import containing custom Rule Lists is validated as one configuration: list IDs and names must be valid and unique, every assignment must reference an imported list, and each target can have at most one assignment per list. Password data remains excluded from import/export as before.

## Categories versus Rule Lists

Categories and Rule Lists remain independent:

- Category describes what kind of target it is, such as Social or News.
- Rule List describes a user context, such as Work or Study.
- A target has one category.
- A target can have multiple assignments, one per Rule List.
- Each assignment can have its own Always, Schedule, or Daily Limit configuration.
