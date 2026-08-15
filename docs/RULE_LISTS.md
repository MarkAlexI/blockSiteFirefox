# Rule Lists

Rule Lists were introduced in BlockDistraction 4.9.0 as a Pro/legacy organization and control layer for blocking rules.

## Data model

Rule Lists are device-local, just like blocking rules. They are stored in `storage.local` under `ruleLists` and are intentionally separate from synchronized settings.

Every blocking rule belongs to exactly one Rule List through `rule.listId`. Whitelist rules remain in the built-in `general` list internally and are not presented as custom-list members in the UI.

The built-in list is:

```json
{
  "id": "general",
  "name": "General",
  "disabled": false
}
```

Existing rules without a `listId` are migrated to `general` automatically.

Custom Rule Lists use stable local IDs such as `list-1`, `list-2`, and so on. The display name is user-defined. List names are normalized, limited to 40 characters, and must be unique case-insensitively.

## Access model

Creating, renaming, toggling, deleting, or directly assigning a rule to a custom Rule List requires Pro or legacy access.

Stored Rule List state is still respected by DNR activation if Pro verification is temporarily unavailable. This prevents a transient licensing or network problem from silently changing the user's blocking configuration.

## Activation

Rule Lists are an additional activation condition. Outside an active Focus Session, a blocking rule is inactive when its assigned list is disabled.

The existing Focus Session precedence is preserved: an active blacklist Focus Session activates blocking rules before individual, category, list, and schedule disabled checks.

The one-minute scheduling alarm and the full DNR self-healing synchronization remain unchanged. Rule List state is read by the existing synchronizer and participates in the normal expected-vs-current DNR diff.

## Deleting a list

The built-in General list cannot be renamed or deleted.

Deleting a custom Rule List never deletes its rules. The list definition and all affected rules are updated atomically, with those rules reassigned to `general`, then the normal DNR synchronization runs.

## Import and export

Exports include both `rules` and `ruleLists`. Imports created before 4.9.0 remain valid because missing Rule List data defaults to General.

An import containing custom Rule Lists is validated as one configuration: list IDs and names must be valid and unique, and every imported blocking rule must reference an imported list. Password data remains excluded from import/export as before.

## Categories versus Rule Lists

Categories and Rule Lists are intentionally independent:

- Category describes what kind of site a rule represents, such as Social or News.
- Rule List describes the user's context or grouping, such as Work or Study.

A rule has one category and one Rule List. Multiple Rule List membership is deliberately not part of the 4.9.0 model.
