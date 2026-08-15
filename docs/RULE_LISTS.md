# Rule Lists

Rule Lists were introduced in BlockDistraction 4.9.0 as a Pro/legacy organization and control layer for blocking rules. The 5.0.0 line extends them with shared membership so one blocking rule can participate in multiple custom lists without duplicating the underlying rule.

## Data model

Rule Lists are device-local, just like blocking rules. They are stored in `storage.local` under `ruleLists` and are intentionally separate from synchronized settings.

Blocking rules store their membership in `rule.listIds`. Whitelist rules remain in the built-in `general` list internally and are not presented as custom-list members in the UI.

The built-in list is:

```json
{
  "id": "general",
  "name": "General",
  "disabled": false
}
```

`General` is the fallback membership. A rule with no custom membership belongs to General. When a General rule is added to a custom list, General is removed from that rule. A rule can then belong to multiple custom lists, for example:

```json
{
  "blockURL": "youtube.com",
  "listIds": ["list-1", "list-2"]
}
```

Legacy rules with a single `listId` are migrated automatically to the canonical `listIds` array. Rules without any list membership fall back to General.

Custom Rule Lists use stable local IDs such as `list-1`, `list-2`, and so on. The display name is user-defined. List names are normalized, limited to 40 characters, and must be unique case-insensitively.

## Access model

Creating, renaming, toggling, deleting, or directly assigning a rule to a custom Rule List requires Pro or legacy access.

Stored Rule List state is still respected by DNR activation if Pro verification is temporarily unavailable. This prevents a transient licensing or network problem from silently changing the user's blocking configuration.

## Activation

Rule Lists are an additional activation condition. Outside an active Focus Session, a blocking rule remains active while at least one of its Rule List memberships is enabled. It becomes inactive only when every list it belongs to is paused.

For example, a rule in both Work and Study remains active if Work is paused but Study is enabled. If both Work and Study are paused, the rule becomes inactive.

The existing Focus Session precedence is preserved: an active blacklist Focus Session activates blocking rules before individual, category, list, schedule, or Daily Limit checks.

The one-minute scheduling alarm and the full DNR self-healing synchronization remain unchanged. Rule List state is read by the existing synchronizer and participates in the normal expected-vs-current DNR diff.

## Adding an existing rule to another list

A blocking rule is stored only once. If the same exact rule already exists in another custom Rule List, adding it to the current list extends its membership instead of creating a duplicate rule.

For example:

```text
Work: youtube.com
+ add youtube.com while Study is selected
= youtube.com belongs to Work and Study
```

Rule Pack imports use the same behavior. Existing matching rules gain the selected list membership; only genuinely new rules create new rule objects.

## Deleting a list

The built-in General list cannot be renamed or deleted.

Deleting a custom Rule List never deletes its rules. The deleted list ID is removed from every affected rule atomically. Rules that still belong to another custom list keep those memberships. If deleting the list removes the rule's final custom membership, the rule falls back to General.

## Import and export

Exports include both `rules` and `ruleLists`. Imports created before 4.9.0 remain valid because missing Rule List data defaults to General and legacy single `listId` assignments are accepted.

An import containing custom Rule Lists is validated as one configuration: list IDs and names must be valid and unique, and every imported blocking rule membership must reference an imported list. Password data remains excluded from import/export as before.

## Categories versus Rule Lists

Categories and Rule Lists remain intentionally independent:

- Category describes what kind of site a rule represents, such as Social or News.
- Rule List describes the user's context or grouping, such as Work or Study.

A rule has one category and can belong to multiple custom Rule Lists. Schedule, Daily Limit, redirect behavior, and other rule settings belong to the single underlying rule and are shared across all of its list memberships.
