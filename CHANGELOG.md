# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.2.0] - 2026-08-26
### Added
- Expanded Rule Packs from five to eight and the curated catalog from 33 to 57 entries.
- Added Messaging, Short-form Video, and Movies and TV packs; Social now includes Bluesky, Tumblr, and Quora, while Gaming includes Chess.com, Lichess, Poki, and CrazyGames.
- Added localized titles and descriptions for the three new packs in all 57 supported locales.
- Added regression coverage for catalog identity, authoritative target validation, intentional cross-pack overlap, path-scoped matching, and atomic Short-form Video imports.

### Changed
- Short-form feeds and web messaging use focused paths for YouTube, Instagram, Facebook, Discord, and Snapchat where the service exposes a stable web route, keeping unrelated pages available.
- Existing duplicate detection, whitelist conflict handling, shared schedules, DNR capacity preflight, Pro and genuine legacy authorization, active-profile isolation, and Firefox Android compatibility remain unchanged.


## [5.1.24] - 2026-08-26
### Security
- Missing or invalid installation metadata no longer grants legacy access by itself; genuine old partial credential records are canonicalized only from the trusted extension update lifecycle.
- Subscription and runtime activation payloads still cannot alter the stored installation date or legacy status.

### Fixed
- Only the owned `markdigital.cc` domain and its subdomains remain protected. The unrelated `markdigital.com` domain and partial targets such as `mark`, `digital`, and `markdigital` can now be blocked normally.
- Manual license activation now takes priority over later startup, daily, or force-sync verification, preventing a valid candidate key from being rejected as superseded or causing a redundant old-key request.
- Update migration now persists a historical installation date and consistent legacy status for existing credentials that predate installation metadata, while modern and uninitialized records remain fail closed.
- DNR exclusions, existing-tab cleanup, Daily Limits, Whitelist Focus, active-profile isolation, genuine legacy access, Free deletion, the exact ten-rule limit, the unchanged one-minute watchdog, and Firefox Android workers without the windows API retain their intended behavior.

### Added
- Added 6 regression scenarios for competitor-domain blocking, trusted credential migration, fail-closed uninitialized metadata, Daily Limit matching, and activation races against no-key and old-key maintenance syncs.
- Expanded lifecycle, DNR, tab cleanup, Whitelist Focus, and windowless worker coverage for the corrected domain and credential contracts.

## [5.1.23] - 2026-08-25
### Security
- Browser DNR rules, matching existing-tab cleanup, Daily Limit tracking, and Whitelist Focus now protect the exact Google authentication, YouTube account-service, project, and Mozilla Add-ons domains without trusting lookalike hosts or URL text.
- Direct rule-creation intents reject protected authentication hosts even when entered with paths or explicit ports, while useful partial targets such as `yout`, `yo`, `goog`, and `block` remain available.

### Fixed
- Google sign-in popups are no longer redirected or closed by YouTube, Google, project-name, or custom-redirect rules; ordinary YouTube, mobile YouTube, Google, and unrelated matching websites remain blocked.
- Startup and the unchanged one-minute watchdog detect old browser DNR rules missing protected-domain exclusions, replace them atomically, and avoid repeated writes or tab scans after the one-time repair.
- Firefox Desktop and Firefox Android preserve Mozilla Add-ons protection without adopting unrelated Chrome or Edge store restrictions or relying on the unsupported windows API.
- Existing schedules, active-profile isolation, Focus authorization, genuine legacy access, Free deletion, the exact ten-rule limit, and native `technicalAndInteraction` telemetry consent remain unchanged.

### Added
- Added 20 regression scenarios for precise authentication and project domains, Firefox-specific store exclusions, partial-pattern preservation, direct host validation, spoofed lookalikes, custom redirects, DNR signatures and recovery, Daily Limits, existing tabs, Whitelist Focus, Firefox Desktop, and Firefox Android.

## [5.1.22] - 2026-08-25
### Security
- Pro activation is now verified and committed authoritatively by the service worker; Options submits only the proposed license key, and paid access requires an explicit `isPro: true` response from the existing license endpoint.
- Direct runtime Pro-status mutations are rejected, and the obsolete credentials endpoint no longer exposes license keys or subscription email.
- Subscription activation and logout cannot overwrite the original installation date or genuine legacy-access state, even when caller or server payloads contain forged legacy fields.

### Fixed
- Temporary HTTP, network, timeout, malformed-response, and storage failures preserve the existing subscription and active Rule List; authoritative `401`/`403` rejections and confirmed inactive candidates remain distinguishable without revoking another valid license.
- Overlapping verification, delayed credential reads, newer activations, and logout share the existing worker transition guards so stale responses cannot restore or replace newer access.
- Password-protected logout, genuine legacy access, Free rule deletion, the exact ten-rule limit, Focus/DNR recovery, the unchanged one-minute watchdog, and Firefox Android workers without the unsupported windows API remain intact.

### Added
- Added 40 regression scenarios for forged runtime Pro and legacy claims, private credential responses, worker-owned activation, strict server approval, candidate validation, HTTP outcomes, retryable failures, timeout cleanup, storage failures, serialized activation/logout races, Firefox Desktop, and Firefox Android.

## [5.1.21] - 2026-08-25
### Changed
- Updated Firefox Add-ons descriptions in all 57 existing locales to highlight privacy-first website blocking on Firefox Desktop and Android, ten free rules, and Pro schedules, Daily Limits, and strict controls.
- Aligned the Mozilla Add-ons publishing summary with the canonical English Firefox description without changing extension behavior, permissions, or Android compatibility.

### Added
- Added store-description regression coverage for exact English and regional English copy, every existing locale, Free and Pro feature disclosure, explicit Firefox and Android targeting, publishing metadata, and the 132-character manifest limit.

## [5.1.20] - 2026-08-24
### Security
- Direct worker rule-creation and editing intents can no longer introduce or modify paid schedule settings without Pro or genuine legacy access.
- Former-Pro users can still preserve an existing schedule while editing its target, remove paid scheduling, toggle or delete inherited rules, and clean preserved custom-list assignments without restoring paid feature access.

### Fixed
- Schedules crossing midnight now remain active from their inclusive start through the next day's exclusive end, including Friday-to-Saturday, Sunday-to-Monday, weekday/weekend, month, and year boundaries.
- After midnight the active interval is associated with its selected start weekday instead of incorrectly requiring the following day to be selected.
- Schedule validation, editing, presets, display, Rule Packs, imports, and legacy single-period records accept valid overnight intervals while still rejecting identical start/end times, malformed times, and overlapping selected days.
- Startup and the unchanged one-minute watchdog restore missed overnight activation, close matching open tabs, and remove expired browser blocking after delayed Firefox Android wake-ups without redundant DNR writes or repeated tab scans across midnight.
- A Daily Limit journal regression fixture now follows the current local date instead of silently expiring after its hard-coded calendar day.
- Free deletion, inherited-schedule cleanup, the exact ten-rule limit, active-profile isolation, disabled categories, Focus behavior, and Firefox Android compatibility without the unsupported windows API remain unchanged.

### Added
- Added 55 regression scenarios covering overnight validation and activation, weekday rollovers, exact interval boundaries, mixed periods, schedule UI/presets/formatting, Rule Packs/imports, browser DNR recovery, delayed and windowless Firefox Android workers, paid authorization, former-Pro cleanup, and stable Daily Limit journal fixtures.

## [5.1.19] - 2026-08-22
### Fixed
- Focus Sessions whose one-shot completion alarm was missed during sleep, shutdown, or a delayed Firefox Android wake-up are now completed from persisted state during startup or the unchanged one-minute watchdog.
- Valid future Focus Sessions restore a missing or stale completion alarm without ending early or rewriting an already correct alarm; both Promise and callback alarm APIs remain supported.
- Alarm, startup, watchdog, replacement-start, and stop transitions share the existing serialized worker state queue, so stale or simultaneous events cannot end a newer session or record completion twice.
- Expired sessions persist their inactive state before cleanup, while Daily Limit sampling, alarm cleanup, DNR synchronization, Statistics, diagnostics, telemetry, and notification failures are isolated from one another.
- Malformed active Focus state is cleared safely without recording a false successful session, and strict UI state reads no longer expose invalid, expired, or partially typed records as active.
- Recovery remains available to Free and former-Pro users, Free rule deletion and the exact ten-rule limit remain unchanged, and Firefox Android workers still do not require the unsupported windows API.

### Added
- Added 26 regression scenarios for missed and stale alarms, startup and minute recovery, callback alarm APIs, exact-boundary expiry, concurrent Focus transitions, failed storage and side effects, DNR repair, Free and legacy access, and windowless Firefox Android workers.

## [5.1.18] - 2026-08-22
### Security
- Pro activation accepts only an explicit boolean subscription approval; malformed truthy server responses can no longer grant paid access, and overlapping submissions cannot race the worker-owned credentials transition.

### Fixed
- Active Pro subscriptions, stored license keys, selected Rule Lists, context menus, and browser blocking survive ambiguous HTTP 400/404/408/409/422/429 responses, server errors, invalid JSON, and verification timeouts.
- Only authoritative HTTP 401/403 rejections or an explicitly verified inactive subscription remove Pro access; real expiration still safely restores General while preserving inactive profiles and browser DNR integrity.
- Daily uninstall metadata refresh, license verification, entitlement-aware context-menu updates, and telemetry delivery now fail independently instead of cancelling the remaining maintenance tasks.
- Genuine legacy installations keep their paid context menu after the daily license alarm without requiring a subscription key; serialized menu refreshes cannot overtake concurrent Pro logout.
- Pro activation now uses the existing ten-second verification timeout, preserves entered keys for retry, distinguishes temporary network/server/worker failures from rejected subscriptions, and always restores its submit button.
- Free rule deletion, the exact ten-rule limit, the existing one-minute watchdog, and Firefox Android workers without the unsupported windows API remain unchanged.

### Added
- Added 42 regression scenarios for ambiguous and authoritative license responses, timeout recovery, malformed subscription contracts, preserved Pro profiles and DNR rules, resilient daily maintenance, legacy and Free context menus, overlapping logout, telemetry delivery after partial failures, duplicate activation prevention, and windowless Firefox Android workers.

## [5.1.17] - 2026-08-22
### Security
- Password-protected rule deletion, assignment removal, rule editing, bulk clearing, settings and Statistics resets, and Pro logout now fail closed if security settings cannot be read or verification cannot run.
- Popup reads current protection settings for each deletion, enforces passwords for both Pro and genuine legacy accounts, and never trusts a stale unprotected settings snapshot.

### Fixed
- Free and former-Pro users can still delete existing rules, remove preserved custom-list assignments, and edit their remaining rules when unrelated settings fail to load or an old Pro password remains stored.
- Verified Pro logout now clears the stored password hash only after its worker-owned access transition succeeds; cancelled verification and failed transitions preserve existing credentials and protection.
- Blocked-page, redirect, Focus Session, and reset operations never overwrite saved Statistics totals or daily history after a failed storage read, initialization, normalization, or write.
- Later serialized Statistics events recover normally after temporary storage errors, while display-only reads retain their existing safe fallback without modifying saved history.
- The exact ten-rule Free limit, DNR integrity, unchanged one-minute watchdog, and Firefox Android compatibility without the unsupported windows API remain unchanged.

### Added
- Added 39 regression scenarios for strict security reads, stale Popup settings, protected Pro and legacy deletion or editing, Free and former-Pro cleanup, password cancellation, guarded logout, failed bulk actions, Statistics read/write failures, queue recovery, and preserved browser blocking.

## [5.1.16] - 2026-08-22
### Changed
- The unchanged one-minute watchdog still evaluates schedules, Daily Limits, Rule Lists, browser DNR integrity, and host permissions, but no longer scans every open tab when active browser protection is already current.
- Startup, explicit rule mutations, Focus Sessions, repaired DNR drift, changed profiles or categories, and newly active scheduled or Daily Limit rules continue reconciling matching open tabs immediately.
- Serialized DNR requests preserve stronger explicit tab-reconciliation intent across overlapping passive watchdogs; superseded snapshots carry required cleanup forward without closing tabs for removed rules.
- Large rule imports now index exact targets and per-profile URL assignments, and blacklist conflict checks examine only relevant whitelist entries instead of rescanning every previously imported rule.
- Thousands of legitimate inactive-profile rules remain importable without an invented total-rule cap; browser-reported DNR limits still apply only to the actually active profile.

### Fixed
- Invalid JSON roots and malformed imported rule entries now fail clearly before changing existing rules, Rule Lists, settings, or browser blocking.
- Existing whitelist conflict order, case-insensitive target matching, duplicate-profile rejection, exact ten-rule Free limit, Free deletion, one-minute recovery alarms, and Firefox Android workers without the Windows API remain unchanged.

### Added
- Added 32 regression scenarios covering passive watchdog tab-scan suppression, schedule and Daily Limit activation, DNR drift repair, overlapping synchronization priorities, startup and Focus enforcement, indexed large imports, whitelist conflict precedence, malformed import rollback, active browser capacity, and windowless Firefox Android workers.

## [5.1.15] - 2026-08-22
### Fixed
- Daily Limit assignment moves, shared-target splits and merges, and Rule List deletion now atomically protect pending usage remaps in the same local write as their committed rules and profiles.
- Temporary Daily Limit read or write failures preserve accumulated seconds, active browser blocking, and source keys; existing startup events, rule intents, and the unchanged one-minute alarm recover pending remaps safely.
- Startup recovers pending usage before schema migration and cleanup; failed recovery defers destructive usage migration, projects pending usage onto its new assignment, and handles local-day rollover without resurrecting yesterday's time.
- Ordinary rules and Daily Limit assignments without elapsed time or an active sample skip unnecessary usage-journal writes, while batched profile deletion preserves its single atomic rule/profile commit.
- Pro and legacy Focus Sessions validate the complete prospective global dynamic and unsafe DNR budget before changing session state; Free Focus still evaluates only General, and Firefox remains compatible when browser limit constants are absent.
- Unexpected Focus DNR synchronization failures restore the previous session and completion alarm, reconcile browser protection, surface actionable errors in Popup, and still return their failure if diagnostics or analytics cannot be persisted.
- Identical DNR failures are deduplicated across non-persistent worker restarts using existing diagnostic state; changed errors, different expected rule counts, and failures after successful recovery remain visible.
- Existing Free deletion, assignment cleanup, toggling, the exact ten-rule General limit, the one-minute recovery alarm, and Firefox Android workers without the Windows API remain unchanged.

### Added
- Added 41 regression scenarios covering atomic Daily Limit journaling, read/write recovery failures, 840-second preservation, target splits and merges, batched profile deletion, startup migration ordering, midnight rollover, write-free idle recovery, restarted worker deduplication, projected Focus capacity, Free/Pro/legacy access, exact session rollback, Popup error visibility, and failed reporting.

## [5.1.14] - 2026-08-22
### Fixed
- Rule additions, edits, Rule Packs, imports, profile activation, and category reactivation now validate browser-reported dynamic and unsafe redirect-rule limits before changing stored state or browser protection.
- Only currently active blacklist redirects consume browser DNR capacity; inactive Rule Lists, disabled categories, disabled rules, and whitelist entries never consume the active budget.
- Basic Free deletion, assignment cleanup, and disabling remain available at the browser rule limit, while the existing ten-rule General limit and preserved former-Pro profiles remain unchanged.
- Oversized imports preserve current rules, Rule Lists, selected profiles, and settings; local rule/profile state is committed before optional sync settings, and failed settings imports produce a clear partial-success warning without disabling imported blocking.
- Daily Limit usage-remapping failures after committed rule edits or profile deletion no longer disguise those mutations as failures or prevent browser DNR reconciliation.
- DNR quota failures preserve existing browser protection, receive actionable telemetry fingerprints, and identical retries no longer rewrite diagnostics or telemetry every minute; the existing one-minute recovery alarm is unchanged.
- Firefox Android and Firefox Desktop remain compatible with missing optional DNR limit constants, and Android workers never require the unsupported Windows API.

### Added
- Diagnostic reports now show active unsafe redirect counts, browser-reported dynamic/unsafe rule limits, and whether the active profile exceeds browser capacity.
- Added 35 regression scenarios covering browser quota detection, safe and unsafe action budgets, inactive profiles, Free deletion and replacement, protected imports, post-commit remap failures, deduplicated failure writes, detailed diagnostics, and workers without the Windows API.

## [5.1.13] - 2026-08-22
### Fixed
- Committed rule additions, deletions, toggles, and other mutations remain successful when post-commit Daily Limit cleanup, sampling, or analytics persistence fails; failed mutations still return their original safe error even if diagnostics and telemetry cannot be saved.
- Browser startup always restores local extension state, repairs former Pro access to General, checks host permissions, samples Daily Limits, and reconciles browser DNR rules; the twelve-hour throttle now applies only to remote license verification.
- Telemetry retry-restoration failures no longer prevent startup recovery, and the existing one-minute scheduled recovery alarm is unchanged.
- Genuine legacy installations retain paid Settings controls, password protection, import/export, bulk actions, browser context-menu blocking, and visible Popup/Options features without requiring an active Pro subscription.
- Credential storage failures fail closed for Pro and legacy authorization and cannot overwrite an existing subscription; normal Free rule toggling and deletion remain available even while sync storage is inaccessible.
- Access snapshots and repeated downgrade checks preserve a concurrently restored legacy entitlement instead of forcing its custom Rule List back to General.

### Added
- Added 21 regression scenarios for post-commit fault injection, resilient error responses, throttled startup recovery, stale DNR rules, telemetry retry restoration, fail-closed credentials, always-Free cleanup, legacy feature access, and Firefox Android workers without the windows API.

## [5.1.12] - 2026-08-22
### Changed
- Idle Daily Limit samples and unchanged assignment cleanup no longer rewrite local storage while preserving active-segment persistence, local-day rollover, and the existing one-minute recovery alarm.
- Scheduled host-permission checks still run every minute but persist unchanged diagnostics at most once every 15 minutes; permission transitions and explicit checks remain immediate.
- Deleting a Rule List remaps only Daily Limit assignments and batches their usage changes into one local-storage write.
- Telemetry no longer rewrites a full daily bucket when a new error fingerprint is discarded at its configured cap.

### Fixed
- Rule storage callbacks now surface read failures and storage-quota errors instead of reporting an unsuccessful mutation as saved.

### Added
- Added write-budget, batch-remapping, quota-failure, permission watchdog, telemetry-cap, and Firefox Android windowless-worker regression coverage.

## [5.1.11] - 2026-08-22
### Fixed
- Pro status updates and Focus start, stop, and completion now share one serialized state-transition queue, preventing a delayed paid Focus start from completing after a downgrade and preventing a concurrent downgrade from superseding a newer Stop request.
- Whitelist Focus tab cleanup now stops when a newer Focus transition wins, and single-tab enforcement rechecks both the current session and current whitelist rules immediately before closing a tab.
- Pro and legacy authorization decisions now come from one credential snapshot, avoiding mixed access results when credentials change between asynchronous storage reads.
- Blocking and Whitelist Focus cleanup now preserve every affected Firefox Desktop window independently instead of protecting only the final tab across all windows.
- Firefox Android uses an unscoped safety tab without accessing the unsupported `browser.windows` namespace.

### Added
- Added deterministic worker race coverage for delayed paid Focus startup, overlapping downgrade and Stop requests, stale initial Whitelist cleanup, and stale per-tab enforcement.
- Added tab-cleanup coverage for per-window safety, superseded Whitelist scans, and Firefox Android windowless fallback behavior.

## [5.1.10] - 2026-08-22
### Fixed
- Whitelist Focus now matches complete domain boundaries and real path descendants while preserving intentional short hostname patterns, closing lookalike-domain and query-string bypasses.
- Protected project and Firefox Add-ons pages are identified by their actual hostnames, preventing unrelated sites from escaping Whitelist Focus through crafted paths, queries, fragments, or lookalike domains.
- Free Focus activates only blacklist rules assigned to General, ignoring preserved custom Rule Lists even when a stale custom profile remains selected in storage.
- Losing Pro access during Hardcore or Whitelist Focus now restores the existing session to a stoppable standard blacklist session while preserving its original deadline and all stored rules.
- Active Focus browser rules are resynchronized immediately after a Pro downgrade even when General was already the selected Rule List.
- Focus requests are validated and authorized in the service worker: Free retains the normal 25-minute session, while custom durations, Hardcore, and Whitelist require Pro or legacy access.
- Firefox Android and Firefox Desktop now share the same guarded Focus recovery and Whitelist enforcement paths without requiring the unsupported `browser.windows` API.

### Added
- Added worker, DNR, tab-cleanup, protected-URL, and whitelist regression coverage for Free, Pro, and legacy Focus behavior, downgrade recovery, malformed requests, stale profiles, and URL bypass attempts.
- Added explicit worker startup coverage without the optional windows API.
- Release checks now verify manifest, package, changelog, README, and optional visible version metadata stay synchronized.

## [5.1.9] - 2026-08-22
### Privacy
- Technical analytics now stops immediately when consent is withdrawn or the Firefox technical data-collection permission is removed, aborting in-flight requests and preventing stale delivery state or retry alarms from being recreated.

### Fixed
- Older license-verification responses can no longer restore a signed-out key, delete a newly activated key, or override the latest verification result.
- Pro activation and logout now use one serialized worker-owned access transition, keeping the context menu and active Rule List consistent when downgrade and upgrade overlap.
- New installations always receive an installation date before Pro access is checked, preventing accidental legacy access from uninitialized credentials.
- Concurrent blocked-page, redirect, Focus Session, and reset operations no longer overwrite aggregate Statistics or daily history counters.
- Focus Session start, stop, and completion operations are serialized, and alarms are bound to their original session deadline so a stale alarm cannot end or count a newer session.
- Daily Limit state normalization and reads now share the same mutation queue as usage samples, preventing stale snapshots from erasing newly recorded usage.
- Superseded DNR synchronization snapshots can no longer close tabs after their blocking rule was changed or removed.

### Added
- Added regression coverage for telemetry opt-out races, stale license responses, overlapping Pro transitions, first-install access checks, concurrent Statistics updates, stale Focus alarms, Daily Limit normalization races, and DNR tab-cleanup invalidation.
- Firefox service-worker race tests explicitly run without the unsupported windows API to protect Firefox Android.

## [5.1.8] - 2026-08-21
### Fixed
- Former Pro users now automatically return to the built-in General Rule List when paid access ends, while existing custom profiles and their rules remain safely stored.
- Extension updates repair Free installations that were already stranded on an inaccessible custom Rule List.
- The ten-rule Free quota now counts only blacklist targets assigned to General, ignoring preserved custom-profile rules and inherited whitelist entries.
- Options and Popup resolve Free views and new rules to General immediately, even if a stale custom profile is still present in storage.
- DNR rules are resynchronized after access recovery so only the General profile remains active, and inherited General rules remain available for deletion.
- Adding or editing a General assignment on an existing custom-only target can no longer bypass the Free rule limit.

### Added
- Added regression coverage for Pro-to-Free recovery on Firefox Android without `browser.windows`, Firefox Desktop, Options and Popup, preserved Rule Lists, quota enforcement, and DNR integrity.
- Documented the native `npm run test:coverage` command for repository-wide test coverage checks.

## [5.1.7] - 2026-08-21
### Changed
- Rule deletion telemetry now counts Rule List assignment removal as a successful deletion, including the normal Delete flow used by Free users.
- Unexpected `pro_required` rejections from always-Free delete, assignment-removal, and toggle operations are now reported as reliability errors while legitimate Pro-only rejections remain excluded.

### Added
- Added regression coverage for Free rule toggling, deleting a rule at the Free limit before adding a replacement, and both client-to-worker deletion routes.
- Added Firefox Android service-worker coverage without the unsupported `browser.windows` API, including existing General-rule deletion and cleanup of custom Rule List assignments after Pro access is lost.

## [5.1.6] - 2026-08-20
### Fixed
- Restored rule deletion for Free users after the Rule Lists migration accidentally routed normal blacklist deletion through a Pro-only assignment-removal gate.
- Free users can again remove their existing General rules and clean up assignments left in custom Rule Lists without requiring a Pro license.

## [5.1.5] - 2026-08-19
### Changed
- Statistics charts now show a readable numeric Y-axis so daily bar heights have an explicit event-count scale.
- The chart legends now show totals for the selected 7-day or 30-day range, and each chart exposes exact daily values on hover, tap, or keyboard focus.
- Daily chart navigation supports Left/Right, Home, and End keys while keeping the latest day selected by default.

### Fixed
- Fixed Daily Limit sampling using inconsistent wall-clock and event timestamps, which could reset the active segment around local-day boundaries and made fixed-time regression tests depend on the current date.

## [5.1.4] - 2026-08-19
### Fixed
- Daily Limit accounting now closes the previous active segment at tab navigation and activation boundaries, so time already spent on the previous page is not lost when the next document is still loading or cannot be probed yet.
- Active Daily Limit tracking is restarted when the new tab document finishes loading, reducing the undercount caused by visibility probes that run too early during navigation.
- Concurrent Daily Limit samples are now serialized without coalescing away navigation events, preserving their original timestamps and tab context.
- Daily Limits now schedule a one-shot deadline alarm from the remaining daily budget, reducing the delay between the configured limit and DNR blocking while retaining the existing minute alarm as a recovery safety net.
- Desktop window focus loss now closes the active Daily Limit segment instead of allowing foreground accounting to continue while the browser is unfocused.

## [5.1.3] - 2026-08-19
### Fixed
- Fixed Firefox for Android background startup failing because the unsupported `browser.windows` namespace was accessed unconditionally while registering the Daily Limit window-focus listener.
- The window-focus listener is now registered only when the Windows API is available, preserving desktop behavior while allowing Firefox Android to start the background worker normally.

## [5.1.2] - 2026-08-18
### Fixed
- Fixed the Open Privacy Settings button on the update page failing to open Options in Microsoft Edge for Android.
- The Edge build now opens the packaged Options page directly, while Chrome keeps the native options-page API with a direct-tab fallback when it is unavailable or reports an error.

## [5.1.1] - 2026-08-18
### Fixed
- Fixed 30-day Statistics date labels being clipped because labels were rendered inside narrow daily chart columns.
- The 30-day axis now shows the month on the first visible label and when the month changes, while intermediate labels show only the day number for a compact mobile-friendly timeline.

## [5.1.0] - 2026-08-18
### Added
- Added device-local daily Statistics history for the latest 30 calendar days, storing only aggregate counts for blocks, redirects, and completed Focus Sessions.
- Added responsive 7-day and 30-day charts inside the collapsed Statistics section without external chart libraries, remote code, or new permissions.

### Changed
- Existing Blocked Today and Redirects Today counters seed the current day's history when upgrading from 5.0.x, while unavailable historical activity is left empty rather than reconstructed.
- Statistics cleanup now prunes entries older than 30 local calendar days automatically, and Clear Statistics removes the retained daily history together with the existing counters.

### Privacy
- Daily Statistics history remains entirely in extension local storage and contains no URLs, domains, browsing history, rule addresses, redirect destinations, account identifiers, or telemetry identifiers.

## [5.0.1] - 2026-08-18
### Changed
- Statistics in Options is now collapsed by default, matching the other large settings sections and leaving room for future statistics visualizations.

### Fixed
- Whitelist rules no longer apply the blacklist-only protected-resource restriction, so allowed patterns such as `markdigital` can be added without the misleading "This resource cannot be blocked" validation error.

## [5.0.0] - 2026-08-18
### Added
- Added Pro Daily Limits, allowing a matching site until the active profile's daily usage budget is exhausted and then blocking it through the existing DNR engine.
- Added explicit Always, Schedule, and Daily limit assignment modes. Schedule and Daily limit are mutually exclusive within one profile assignment.
- Added device-local Daily Limit usage state with automatic reset on the local calendar day.
- Added translated Rule List profile and Daily Limit interface strings across all supported locales.

### Changed
- Reworked Rule Lists into mutually exclusive profiles. Exactly one Rule List is active during normal blocking, with General as the default profile.
- Stored URL, redirect, and category once per target while allowing profiles to share an exact target or keep distinct target variants when redirect or category differs.
- Scoped Category Blocking state and category counts to the active Rule List profile.
- Simplified Options so Rule List cards are the profile selector and the rules table always represents the active profile without a redundant List column.
- Rule Packs and manually added rules now create assignments in the active profile, while matching existing targets receive an additional profile assignment instead of a duplicate target.
- Editing or removing a rule in Options affects only the active profile assignment when the target is shared with other profiles.
- Deleting a custom profile preserves targets used only there by moving their removed assignment configuration to General.
- Preserved Focus Session as a global override above profile, category, Schedule, and Daily Limit state.
- Preserved Firefox Promise-based runtime messaging, native telemetry consent, and Firefox Android behavior while porting the profile model.
- Migrated legacy `listId`, RC multi-membership `listIds`, root enabled state and blocking configuration, profile state, and Daily Limit usage into the canonical profile-assignment model.
- Migrated legacy global disabled categories into the General profile.
- Limited Rule Lists to seven profiles total, including General, while preserving any already stored test data instead of silently truncating it.

### Improved
- Daily Limit usage is assignment-scoped so the same target can keep independent budgets in different profiles.
- Daily Limit foreground accounting verifies that the matching page is visible through the Page Visibility API before charging usage.
- Daily Limit matching now follows BlockDistraction's flexible DNR-style rule semantics, including partial domain-label rules such as `yout` and path-prefix rules.
- Long browser sleep or background gaps are never charged when foreground continuity cannot be proven.
- Reused the existing one-minute alarm and DNR self-healing flow without adding interval timers, offscreen documents, or persistent content-script timers.
- Preserved Daily Limit configuration in rule import/export while keeping accumulated usage device-local and out of exported data.
- Added regression coverage for profile activation, profile-scoped categories, assignment migration, independent schedules and limits, flexible URL matching, DNR activation, mutation security, localization, and import/export compatibility.
- Distinguished release-candidate builds in the existing telemetry version dimension during pre-release testing without changing the schema-v2 wire contract; production reports use `5.0.0`.

### Fixed
- Fixed the compatibility migration alert appearing late or repeatedly after internal Daily Limit state cleanup; it now applies only to actual rule/profile migrations during an extension update and is claimed once per version.
- Expected user-input and business-rule rejections now use non-error logging and informational diagnostics instead of `console.error`, so invalid names, redirects, duplicates, limits, and similar handled cases do not appear as browser extension failures.
- Prevented an empty Rule List name click from sending a rejected mutation intent at all; the Options page now handles it locally.
- Fixed adding the same block URL with a different redirect or category to another profile silently reusing the old target and discarding the newly entered target fields.
- Editing URL, redirect, or category on one assignment of a shared target now splits or merges the target as needed instead of rewriting target fields for every profile, while preserving assignment-scoped Daily Limit usage.
- Daily Limit progress now refreshes in open Options and Popup views when local usage changes and shows sub-minute progress instead of remaining visually at zero until the next whole minute.
- Focus Session now emits one deterministic DNR rule when different profiles contain target variants for the same block URL, preferring the active profile's target.
- Import and Rule List deletion now preserve the one-target-per-block-URL-per-profile invariant when target variants exist.
- Fixed enabling or disabling a shared target in one Rule List changing its state in every other profile.
- Fixed an exhausted Daily Limit assignment becoming unblocked when the same target was disabled in another profile.
- Fixed Daily Limits staying at zero on Chromium Android when desktop-style window focus APIs reported the browser as unfocused.
- Fixed Daily Limit URL attribution using stricter hostname matching than the extension's actual DNR rules.
- Fixed Rule Pack and manual additions ignoring the selected Rule List context in earlier 5.0.0 candidates.
- Fixed localized input placeholders, including the Rule List name placeholder, not being applied from `data-i18n-placeholder`.
- Removed a redundant Rule List storage write when creating a custom list.

## [4.9.0] - 2026-08-15
### Added
- Added Pro Rule Lists for organizing blocking rules into named lists such as Work or Study.
- Added per-rule list assignment, whole-list pause/resume controls, list filtering, and Rule List management in Options.
- Added device-local Rule List import/export and automatic migration of existing rules to the built-in General list.
- Added Rule List interface strings across all supported locales.

### Improved
- Integrated disabled Rule Lists with the existing Firefox DNR self-healing flow without changing the one-minute scheduling alarm.
- Deleting a custom Rule List now safely moves its rules to General instead of deleting them.
- Firefox popup rule rows now identify custom Rule Lists and reflect paused-list state.
- Preserved Firefox Promise-based runtime messaging, native telemetry consent, and Firefox Android behavior while adding Rule Lists.
- Added regression coverage for Rule List storage, migration, mutation intents, DNR activation, UI behavior, import/export contracts, and localization.

## [4.8.7] - 2026-08-13
### Fixed
- Stopped transient license verification failures such as network errors, timeouts, rate limits, server errors, and invalid transient responses from being counted as extension reliability errors in opt-in telemetry.

### Improved
- Kept transient license verification failures in local diagnostics for troubleshooting while reserving remote reliability errors for unexpected extension failures.
- Converted Firefox runtime messaging to the native Promise style for request/response and fire-and-forget calls, consuming expected no-receiver rejections without Chromium `runtime.lastError` callbacks.
- Added regression coverage for license reliability-error classification and Firefox Promise-based runtime messaging.

## [4.8.6] - 2026-08-13
### Fixed
- Stopped expected rule validation and business-rule rejections from being counted as reliability errors in opt-in telemetry.
- Kept unexpected rule mutation failures, stale-state failures, DNR/runtime failures, and unknown rule intent failures visible to reliability telemetry.
- Fixed password-protected rule deletion in Strict Mode asking for the password a second time after the countdown.
- Prevented the Strict Mode confirmation click from re-entering the original delete handler and starting a second deletion flow.
- Fixed Firefox release validation so it no longer requires the unrelated Chrome Web Store badge version to match the Firefox manifest version.

### Improved
- Added regression coverage separating expected user-facing rule rejections from unexpected rule failures.
- Added regression coverage for the Strict Mode delete confirmation state.
- Documented that validation failures such as invalid redirects, schedules, conflicts, duplicates, limits, and invalid imports are excluded from reliability error metrics.

## [4.8.5] - 2026-08-13
### Fixed
- Fixed the Firefox Options telemetry toggle failing to enable native `technicalAndInteraction` consent because an asynchronous permission lookup ran before `browser.permissions.request()`, causing Firefox to lose the required user-action context.
- Kept Firefox's required `none` data-collection declaration together with optional `technicalAndInteraction`, which is required for the working AMO/Firefox consent configuration.

### Improved
- Added regression coverage ensuring the native telemetry permission request starts immediately from the user action without a preceding asynchronous permissions query.

## [4.8.4] - 2026-08-12
### Fixed
- Made telemetry delivery idempotent by assigning a retry-stable random ID to each prepared delivery snapshot, preventing a lost server response from counting the same schema-v2 batch twice.
- Preserved same-day telemetry recorded while a request is in flight by acknowledging only the prepared snapshot and assigning a fresh delivery ID to any remaining events.

### Improved
- Upgraded the telemetry wire contract to schema version 2 with ephemeral per-delivery UUIDs that are not installation identifiers and disappear with the acknowledged local snapshot.
- Preserved Firefox native `technicalAndInteraction` consent and Firefox telemetry context while aligning delivery semantics with the Chromium implementation.
- Added regression coverage for stable retry IDs, stale acknowledgements, schema-v2 payloads, and concurrent same-day telemetry.

## [4.8.3] - 2026-08-11
### Improved
- Extended opt-in technical telemetry with aggregated counters for feedback prompt displays, Mozilla Add-ons review clicks, support clicks, and dismissals.
- Routed popup feedback counters through the service worker and the existing strict telemetry allowlist, while preserving Firefox native `technicalAndInteraction` consent and keeping schema version 1 unchanged.
- Added regression coverage for feedback counter reporting, allowlist rejection, Firefox Promise-based fire-and-forget messaging, and service-worker aggregation.

## [4.8.2] - 2026-08-10
### Changed
- Replaced the old positive/negative review gate with one neutral feedback prompt in the popup that offers the Mozilla Add-ons review page and support side by side.
- Moved automatic feedback prompting out of the Options page so regular popup users, including Firefox for Android users, can actually see it.
- Show the prompt only after at least seven days and meaningful local use: two saved rules, five handled blocks/redirects, or one completed Focus Session.
- Limit automatic feedback prompting to two displays per installation, with a fourteen-day snooze after the first display.
- Preserve completed legacy feedback state so users who already responded are not prompted again after the migration.
- Store new feedback prompt state locally instead of synchronizing it across Firefox installations.

### Improved
- Open the dedicated Mozilla Add-ons reviews page directly from the review action.
- Kept the feedback implementation Firefox-native with `browser.storage` and `browser.tabs` rather than importing Chromium store-target logic.
- Added regression tests for feedback eligibility, snoozing, legacy migration, and Firefox review/support routing.

## [4.8.1] - 2026-08-10
### Fixed
- Preserved specific privacy-safe rule failure codes in technical telemetry instead of collapsing every rejected rule mutation into `intent_failed`.
- Persisted telemetry bucket context when a UTC-day bucket is first created so queued events keep the Firefox version, access tier, locale, platform, OS, and installation-age context from collection time.
- Physically removed telemetry buckets older than the documented seven-day local retention window when the queue is inspected.
- Added a real one-shot telemetry retry alarm so exponential delivery backoff is no longer dependent on the next daily maintenance wake-up.
- Prevented successful delivery acknowledgements from deleting new same-day telemetry events recorded while a request was in flight.

### Improved
- Kept the schema-v1 wire protocol unchanged by grouping pending buckets by their captured context and sending separate compatible requests when necessary.
- Preserved Firefox built-in `technicalAndInteraction` consent as the source of truth on supported versions and the local opt-in fallback on older supported versions.
- Added delivery retry details to the privacy-safe Diagnostic Report.
- Added regression tests for rule error classification, Firefox context preservation, persisted retention cleanup, context-grouped delivery, and retry scheduling.

## [4.8.0] - 2026-08-08
### Added
- Added opt-in privacy-preserving technical analytics for the Firefox build, disabled by default.
- Added Firefox built-in `technicalAndInteraction` consent integration on supported Firefox versions, with the existing in-extension opt-in used as a fallback on older supported versions.
- Added daily aggregated feature-use counters and a seven-day local telemetry queue.
- Added privacy-safe error fingerprints for DNR, permission, license, rule, Focus Session, background worker, popup, and Options failures.
- Added a versioned `POST /api/telemetry` client contract with batch delivery, timeout handling, retention, and exponential backoff.
- Added a localized Privacy & Technical Data section to every supported locale.
- Added telemetry delivery state to the privacy-safe Diagnostic Report.

### Privacy
- No browsing history, blocked website addresses, rule addresses, redirect URLs, email, license key, passwords, raw error messages, stack traces, or persistent telemetry identifier are collected by the telemetry client.
- No telemetry data is stored before explicit consent. Disabling telemetry clears all pending telemetry buckets and delivery state immediately.

### Improved
- Added coarse page-level reporting for uncaught errors and unhandled promise rejections without transmitting messages, filenames, URLs, or stack traces.
- Reused the existing daily license alarm for telemetry delivery instead of adding another recurring wake-up.
- Added dependency-free tests for consent, data minimization, aggregation, retention, delivery backoff, UI behavior, localization, and the telemetry request contract.

## [4.7.1] - 2026-08-07
### Fixed
- Fixed `Illegal invocation` when clearing diagnostic history by preserving the native confirmation function context.
- Restored reliable detection of revoked host permissions without bringing back per-tab activation checks.

## [4.7.0] - 2026-08-06
### Added
- Added a Pro Diagnostic Report to the Options page with generate, copy, JSON export, and history clearing actions.
- Added a capped local buffer for structured diagnostic events collected only while Debug Mode is enabled.
- Added live report data for extension and browser versions, access state, settings, rule counts, DNR integrity, host permissions, Focus Session, and license verification.

### Improved
- Redacted URLs, domains, email addresses, license keys, tokens, passwords, and other sensitive values before diagnostic data is stored or exported.
- Added DNR inspection without modifying browser rules and recorded only meaningful DNR changes or failures.
- Stopped checking host permissions on every tab activation and kept checks on install, update, startup, and permission removal events.
- Added localized Diagnostics interface strings for every supported locale.
- Added dependency-free tests for privacy filtering, event buffering, report formatting, UI actions, and DNR inspection.

## [4.6.1] - 2026-08-06
### Fixed
- Opened the shared Rule Pack schedule editor above the existing Rule Packs modal instead of behind it.
- Closed and removed an unfinished nested schedule editor when the Rule Packs dialog is cancelled or closed.
- Applied the default weekday schedule when scheduling is enabled without opening the editor, preventing newly imported rules from receiving `null` schedules.
- Kept Escape scoped to the nested schedule editor before allowing it to close the Rule Packs dialog.
- Added regression tests for nested modal hosting, cleanup, and default shared schedule retrieval.

## [4.6.0] - 2026-08-06
### Added
- Added an optional shared schedule to the Rule Packs import dialog.
- Reused the advanced schedule editor so selected pack rules can receive weekday, weekend, or custom time groups before import.

### Improved
- Normalized and validated the shared schedule inside the service worker before changing stored rules.
- Applied one independently cloned schedule to every newly added pack rule with one storage write and one DNR synchronization.
- Kept duplicate and whitelist-conflicting rules unchanged while preserving detailed import reports.
- Added dependency-free tests for UI payloads, client messaging, schedule normalization, validation, and atomic imports.

## [4.5.2] - 2026-08-06
### Improved
- Replaced the compact Rule Pack result sentence with a clear three-part import report.
- Listed the exact addresses that were added, already existed, or were skipped because of whitelist conflicts.
- Preserved the existing result counters while adding structured added and duplicate entry details from the service worker.
- Added localized report labels and dependency-free regression tests for detailed and count-only responses.

## [4.5.1] - 2026-08-06
### Improved
- Translated the complete Rule Packs interface into every supported locale.
- Preserved Rule Pack result placeholders consistently across all translations.
- Added dependency-free localization tests that detect missing keys, placeholder mismatches, and accidental English fallbacks.

## [4.5.0] - 2026-08-06
### Added
- Added local Pro Rule Packs for social media, video and streaming, news, shopping, and gaming.
- Added a preview dialog where users can inspect every address and select only the rules they want.
- Added the atomic `rules:addMany` worker intent for adding a complete selection with one storage write and one DNR synchronization.

### Improved
- Kept Rule Pack definitions inside the extension with no remote list updates or automatic additions.
- Skipped exact duplicates and whitelist conflicts without modifying existing rules.
- Added dependency-free tests for pack integrity, selection validation, atomic additions, duplicates, conflicts, access control, client messaging, and intent routing.

## [4.4.1] - 2026-08-06
### Fixed
- Kept every category blocking control visible after disabling a category, including categories with no currently counted rules.
- Preserved all category rules in the Options table while displaying disabled categories as inactive and non-interactive.
- Repositioned the schedule time-group removal button so it no longer overlaps the Saturday checkbox on desktop or mobile.

## [4.4.0] - 2026-08-05
### Added
- Added advanced Pro schedules with separate time groups for different days of the week.
- Added quick schedule presets for every day, weekdays, and weekends.
- Added a dedicated schedule editor that keeps long rule rows compact while supporting multiple day and time groups.

### Improved
- Kept all existing single-period schedules fully compatible without a bulk migration.
- Updated schedule summaries in the Options page and popup to display multiple time groups clearly.
- Added dependency-free tests for schedule normalization, validation, presets, formatting, and activation.

## [4.3.3] - 2026-08-05
### Fixed
- Fixed category blocking controls on the Options page toggling twice and immediately restoring their previous state.
- Restored the ability for Pro and legacy users to disable or re-enable all rules in an individual category.
- Replaced manual card click forwarding with native label behavior to keep checkbox interaction reliable and accessible.

## [4.3.2] - 2026-08-05
### Improved
- Added a stronger divider after every ten visible rules on the Options page to make long and filtered lists easier to scan.
- Separated the redirect column label, optional placeholder, and full-URL guidance into dedicated localized messages.
- Added a touch-device hint explaining how to block a copied link when a mobile browser does not provide an extension context menu.
- Clarified redirect validation by reminding users to enter a complete URL including `https://` or leave the field empty for normal blocking.

## [4.3.1] - 2026-08-05
### Improved
- Reduced `RulesManager` to current rule storage, validation, duplicate detection, and conflict checks.
- Moved legacy rule migrations into a dedicated service with explicit storage dependencies.
- Moved rule activation decisions and DNR rule construction into isolated, testable modules without changing matching or schedule behavior.
- Moved rule intent routing out of the service worker into a small tested command router.
- Added a dependency-free `npm run check` command for tests, syntax checks, JSON validation, manifest references, version consistency, and referenced English localization keys.
- Expanded the permanent test suite to cover migration safety, rule activation, DNR construction, intent routing, validation semantics, and service-worker module loading.
### Fixed
- Protected existing local rules from being overwritten by stale synchronized rules when the migration flag is missing.
- Ensured migrated rules and the device migration flag are written together when copying legacy synchronized rules.
- Kept failed storage migrations retryable by not marking them as completed.

## [4.3.0] - 2026-08-04
### Improved
- Centralized all rule mutations from the popup, Options page, imports, bulk clearing, and context menu in the service worker.
- Serialized rule changes so simultaneous actions cannot overwrite one another or reuse the same rule ID.
- Enforced rule limits and protected rule-management actions inside the service worker, not only in the user interface.
- Switched editing, toggling, and deletion from list indexes to stable rule IDs, including filtered Options views.
- Separated rule commands from completed `rules:changed` notifications for clearer and more reliable UI updates.
- Made imports validate the complete replacement set before changing stored rules, without an intermediate empty state.
- Kept DNR synchronization recoverable: stored rules remain authoritative if a temporary browser DNR update fails.
- Added unit coverage for concurrent mutations, stable-ID operations, validation key arrays, safe replacement, free limits, and complete DNR clearing.
### Fixed
- Prevented popup, Options, and context-menu actions performed close together from losing previously saved changes.
- Preserved the complete array of validation localization keys when errors cross the service-worker messaging boundary.
- Ensured clearing all rules passes the full dynamic rule ID list together with an explicit empty `addRules` array.

## [4.2.7] - 2026-08-04
### Improved
- Replaced full DNR rule rebuilds with content-aware synchronization that updates only added, removed, or changed rules.
- Preserved stable rule IDs while atomically replacing edited DNR rules whose conditions or actions changed.
- Serialized overlapping DNR synchronization requests to prevent older runs from overwriting newer rule state.
- Extracted DNR synchronization into a dedicated module with dependency injection for isolated testing.
- Added permanent unit tests for DNR diffing, stable-ID replacement, integrity recovery, and overlapping sync requests.
### Fixed
- Updated DNR integrity validation to compare the browser rules with the actual active rule set, excluding disabled, inactive scheduled, category-disabled, and whitelist rules.
- Removed an obsolete migration call to the deleted `syncDnrRules` method.

## [4.2.6] - 2026-08-04
### Fixed
- Fixed password protection being disabled when importing an export without password credentials.
- Cancelling password setup now closes the modal without invoking the setup callback; verification cancellation still resolves as `false`.
- Preserved the current Pro status during temporary license verification failures, including rate limits, server errors, timeouts, network errors, and invalid JSON responses.
- Added a timeout to background license verification requests.
- Resolved pending password confirmation promises when the modal is cancelled or closed with Escape.
- Corrected Focus Session timers for durations of one hour or longer.
- Reloaded popup rules after a failed deletion instead of removing the rule from the interface.
- Removed duplicate extension initialization during install and update events.
- Limited Focus Whitelist checks on tab updates to actual URL changes.
- Corrected the localization key for the Category table header.
- Excluded password protection fields from exported settings and preserved the current password state during import.

## [4.2.5] - 2026-08-01
### Improved
- Refactored and reorganized styles for better maintainability.
- Removed conflicting CSS rules.

## [4.2.4] - 2026-07-26
### Improved
- Improved the appearance of the `Focus Session` mode selector in the popup.

## [4.2.3] - 2026-07-23
### Changed
- After installation, the extension now opens the Settings page instead of the website.

## [4.2.2] - 2026-07-21
### Added
- Completed full internationalization (i18n) coverage across all supported locales.
- Added `title` attributes to whitelist rules in the popup UI for better tooltip visibility and user experience.
### Fixed
- Fixed an issue on the Options page where the "Add Whitelist Rule" button was not hidden during an active Focus Session.
- Fixed whitelist rules displaying unlocalized text in the schedule column on the Options page (now correctly shows localized "Allow" status).

## [4.2.1] - 2026-07-20
### Fixed
- **DNR Rule Synchronization:** Fixed an issue where editing existing rules (modifying domains, redirect URLs, or toggle states) updated storage and UI but failed to take effect in the browser's network engine. Rule updates are now applied atomically and reflect immediately.

## [4.2.0] – 2026-07-20
### Added
- **Whitelist Focus Mode for Pro Users:** Added a new focus mode option ("Allow Whitelist Only"). During an active session in this mode, all open and newly created tabs are restricted exclusively to sites listed in your Whitelist.
### Improved
- **Safe Batch Tab Enforcement:** Integrated a background tab closure routine (`closeNonWhitelistedTabs`) that automatically clears non-whitelisted sites upon starting a Whitelist focus session, while intelligently preserving internal browser pages, extension settings, and preventing accidental browser window termination.
- **Dynamic Focus Session Controls:** Added a mode selector dropdown in the popup UI, which dynamically unlocks and configures Whitelist focus features.

## [4.1.2] - 2026-07-19
### Changed
- **UI Accessibility:** Enhanced the visual contrast of action buttons and list items within the Whitelist (Allow-rules) interface to ensure better text readability and a more accessible user experience.

## [4.1.1] - 2026-07-19
### Fixed
- **Rule Update Crash:** Fixed a bug that prevented existing rules (both Allow-rules and Block-rules) from being updated due to a variable name typo.
- **Self-Conflict Validation:** Resolved a logic issue where editing non-URL fields of a rule (such as schedule or category) would incorrectly trigger a false positive validation conflict against itself.

## [4.1.0] – 2026-07-19
### Added
- **Whitelist Feature ("Allow-rules")**: Added support for Pro-version exclusion rules, which take priority over blocking and are mutually exclusive with the blacklist.
- **Smart Cross-Conflict Validation**: Overhauled the `checkConflict` algorithm in `RulesManager`.

## [4.0.1] – 2026-07-15
### Improved
- Scheduled rules now display their blocking schedule in the popup instead of a checkmark.

## [4.0.0] – 2026-07-14
### 🚨 BREAKING CHANGES
- **Storage Migration:** Rules database has been migrated from `browser.storage.sync` to `browser.storage.local`. Automatic background synchronization of rules across different devices is no longer supported. General extension settings (theme, toggles) are still synchronized via sync storage.
### Added
- Unlimited capacity for power users (up to 10MB+ storage via `local` API), completely bypassing Firefox's legacy `QUOTA_BYTES_PER_ITEM` errors.
- One-time local migration handler to safely move existing rules from sync to local storage on the first launch of v4.0.0.
### Fixed
- Fixed browser extensions crashing or throwing unhandled database exceptions when saving massive rule lists.

## [3.10.10] – 2026-07-13
### Fixed
- **Service worker alarm resets on mobile:** Fixed a critical issue in Firefox Mobile (GeckoView) where background alarms were repeatedly reset to their initial delay upon every service worker wake-up. Integrated an asynchronous `browser.alarms.get` verification routine to ensure persistent, non-overlapping background scheduling.
- **Fragile background delays:** Eliminated legacy `setTimeout` structures inside the startup and permission handlers. DNR integrity checks and state hydration now execute via solid, synchronous promise chains (`await`), preventing the browser from prematurely killing the background script during active processing.

### Improved
- **Tab switching performance:** Optimized the `onActivated` tab listener to strictly handle authorization states without re-triggering heavy storage queries. This completely removes CPU overhead and battery drain during rapid tab switching on mobile devices.
- **Deterministic lifecycle execution:** Re-architected the `checkAndRequestPermissions` state lock using a robust `try...finally` block, ensuring the permission flag state resets instantly and reliably regardless of execution errors.

## [3.10.9] – 2026-07-11
### Fixed
- Fixed the display of weekday names in scheduled blocking rules. They are now shown in your selected language.

## [3.10.8] - 2026-07-10
### Improved
- Expanded the list of protected URL patterns to prevent blocking essential developer resources.

## [3.10.7] - 2026-07-09
### Changed
- **Dynamic focus session visibility:** Enhanced the popup UX by dynamically toggling the focus session section based on the user's rules list. The focus section is now hidden by default if no blocking rules exist, keeping the interface clean and clutter-free for fresh installs.
- **Reactive UI state handling:** Integrated visibility logic directly into the central `updateStatus` routine. The focus control panel now automatically reveals itself the moment a rule is added (via the popup or the "Block this site" button) and seamlessly hides if all rules are deleted.
- **Layout shift prevention:** Added the `hidden` utility class directly to the HTML structure to prevent any visual flickering or layout shifts during the popup's initialization phase.

## [3.10.6] - 2026-07-08
### Changed
- **Batch tab closure optimization:** Replaced individual, loop-bound `chrome.tabs.query` operations with a unified batch function. The extension now queries open tabs exactly once and checks them against all active patterns simultaneously, reducing browser API overhead and fixing noticeable delays during focus session activation.
- **Centralized DNR synchronization:** Removed the redundant `syncDnrRules` method from `RulesManager`. The service worker is now established as the single source of truth for all `declarativeNetRequest` updates, preventing double-syncing resource consumption when rules are saved.
- **Streamlined rule saving:** Refactored popup and options actions to strictly handle data storage and trigger a single background reload event, ensuring smooth, non-blocking UI transitions.

## [3.10.5] - 2026-07-07
### Fixed
- **Restored redirect functionality:** Fixed a critical bug where `normalizePathSegment` incorrectly applied `encodeURIComponent` to the entire redirect URL, transforming `https://` into `https%3A%2F%2F` and causing `new URL()` and `location.replace()` to fail in `redirect.js`.
- **Flexible keyword blocking:** Separated the normalization logic for path segments/domains from full redirect URLs. Keyword-based matching (e.g., entering `tube` to block `youtube.com`) remains fully functional.
- **Parameter security:** Improved validation for incoming `from` and `to` query parameters inside `redirect.js` to prevent crashes when handling malformed strings.

## [3.10.4] - 2026-07-03
### Added
- Added an option to disable the notification sound when a focus session ends. Availability may vary depending on your browser and operating system.

## [3.10.3] - 2026-07-03
### Improved
- Starting a focus session now automatically closes any open tabs that match your blocking rules, helping you stay focused from the very beginning.

## [3.10.2] - 2026-07-01
### Added
- **Localization:** Added translations for the Focus Session tool (including sound notifications, Hardcore mode, and custom duration strings) across all supported locales.

## [3.10.1] - 2026-06-30
### Fixed
- **Options Page:** Added real-time reactive UI locking/unlocking for rule management. The settings page now instantly reflects focus session status changes (started or stopped via popup) using `browser.storage.onChanged`.
- Improved focus banner state synchronization to avoid async message response conflicts within the service worker.

## [3.10.0] - 2026-06-29
### Added
- **Focus Session:** A new powerful tool designed for maximum concentration when you need it most.
- **Hardcore Mode:** A new feature for **Pro** users that hides the "Stop" button during an active session.
- **Status Banner:** Added a visual banner to the settings page that displays the currently active focus session and the remaining time.
### Changed
- **UI Locking:** During an active Focus Session, the rule management UI is now locked to prevent impulsive changes.

## [3.9.11] - 2026-06-28
### Added
- Added Malayalam language support.

## [3.9.10] – 2026-06-27
### Added
- Added ka localization support.

## [3.9.9] – 2026-06-26
### Added
- Added es_419 localization support.

## [3.9.8] - 2026-06-21
### Improved
- Cleaned up localization files by removing unused translation entries.

## [3.9.7] - 2026-06-20
### Improved
- Added new localized messages for rule validation.

## [3.9.6] - 2026-06-19
### Improved
- Rules created from the context menu now display website names in a more user-friendly format, including sites that use non-Latin characters.

## [3.9.5] - 2026-06-18
### Improved
- Enhanced rule validation when creating blocked website entries.
- Added support for blocking `data://` and `file://` URL schemes.
- Prevented creation of rules matching the `blockdistraction` pattern.
- Applied the same validation rules to Pro mode context menu actions.

## [3.9.4] - 2026-06-17
### Fixed
- Added URL normalization before creating declarativeNetRequest rules.
- Fixed rule creation failures caused by unsupported characters in urlFilter values.

## [3.9.3] - 2026-06-16
### Fixed
- Fixed URL validation for blocked websites. Non-ASCII characters and uppercase letters are now supported.

## [3.9.2] - 2026-06-15
### Fixed
- Fixed the behavior of the scroll up button on a popup when it was jumping on the desktop.

## [3.9.1] - 2026-06-13
### Improved
- Improved worker logic related to opening the update page.

## [3.9.0] - 2026-06-12
### Added
- Added a scroll-to-top button that appears when the popup content is scrolled down.

## [3.8.11] - 2026-06-11
### Improved
- Added localization support for Pro mode context menu entries.

## [3.8.10] - 2026-06-06
### Fixed
- Fixed an issue where the popup could open scrolled to the bottom instead of showing the main controls.

## [3.8.9] - 2026-06-06
### Improved
- Refined popup styling and improved the visual presentation of motivational quotes.

## [3.8.8] - 2026-06-05
### Added
- New motivational quotes added in all languages.

## [3.8.7] - 2026-06-04
### Added
- Added 10 new motivational quotes across all supported locales.

## [3.8.6] - 2026-06-03
### Improved
- Cleaned up localization files by removing unused translation keys.

## [3.8.5] - 2026-06-01
### Improved
- Internal cleanup and license system refinements.

## [3.8.4] - 2026-05-31
### Improved
- Enhanced license validation by adding version-aware compatibility checks.

## [3.8.3] - 2026-05-30
### Fixed
- **Options Page:** Resolved a critical UI bug where the rule editing interface would break on desktop devices. Previously, long content in rules or the schedule container would push the "Save/Cancel" buttons off-screen or make them unreachable.
- **Schedule Layout:** Converted the schedule grid to a compact vertical stack, preventing horizontal layout overflow.
- **Action Buttons:** Enhanced layout stability to ensure action buttons remain accessible within the viewport during rule editing, regardless of content length or localization.
- **UI/UX:** Added improved visual styling to schedule blocks (shadows, borders) for better consistency with the overall design.

## [3.8.2] — 2026-05-28
### Added
- **Localization:** Added informative 7-day free trial notes (`trialproheader` and `trialprotext`) inside the Pro access section on the settings page, fully localized across all supported languages.

## [3.8.1] — 2026-05-24
### Fixed
- Fixed an issue in the worker where declarativeNetRequest rules could create an empty rule instead of updating due to an incorrect method call.

## [3.8.0] — 2026-05-19
### Added
- Feedback submission feature.

## [3.7.9] — 2026-05-15
### Patch
- Fixed statistics reset behavior in Pro mode: the reset date is now updated correctly instead of the creation date.

## [3.7.8] — 2026-05-14
### Patch
- Added app version display to the options page.

## [3.7.7] — 2026-05-13
### Patch
- Category blocking now closes tabs related to active rules that were opened while the rule was disabled.

## [3.7.6] — 2026-04-28
### Patch
- Fixed an issue where saving an edited rule could close related tabs even if the rule was disabled.

## [3.7.5] — 2026-04-28
### Patch
- Fixed blocking patterns that control resource blocking exclusions.

## [3.7.4] — 2026-04-27
### Patch
- Fixed match pattern for `host_permissions`.
- Fixed a bug where extra onboarding pages could open.

## [3.7.3] — 2026-04-27
### Patch
- Fixed an issue where the onboarding page did not open after permissions were lost (e.g. due to browser policy updates).

## [3.7.2] — 2026-04-26
### Fixed
- Fixed an issue with blocking rule by index.

### [3.7.1] – 2026-04-15
### Patch
- Added missing translations for category blocking across all supported languages

## [3.7.0] — 2026-04-14
### Added
- **Category Blocking**: New functionality that allows pausing or resuming the blocking of entire groups of sites (Social Media, News, Games, etc.) with a single click.
- **Hierarchical Management**: Rules now automatically become inactive (Read-only) if their parent category is unlocked.
- **Visual Indicators**: Added dashed borders and a "frozen" effect (grayscale) for rules currently inactive due to category settings.
- **Animations**: Smooth transitions when expanding and collapsing settings sections.
### Improved
- **UI Update**: Settings sections (Security, Advanced, Rules Management) are now collapsed by default for a cleaner look.
- **Options Page UX**: The "Add New Rule" button has been moved closer to the table for easier access.
- **Popup Synchronization**: The popup now instantly reflects changes in category statuses and blocks interaction with "muted" rules.
### Fixed
- `TypeError` error when quickly switching rule statuses.
- - Issue with the lack of reactivity of rule counters in category "chips".

## [3.6.0] - 2026-04-04
### Added
- **Developer Tools**: Introduced `checkDNR()` command in the Options page console. This allows real-time inspection of active `declarativeNetRequest` rules directly in the browser.
- New `utils/dnrDebug.js` module to handle internal rule diagnostics.
### Improved
- **Rule Inspection**: Enhanced the display of active rules in the console; nested objects are now flattened into a readable table format for easier debugging.
- Internal code organization and better separation of concerns between UI and utility functions.

## [3.5.1] – 2026-04-04
### Patch
- Added two new localization keys across all supported languages.

## [3.5.0] - 2026-04-04
### Added
- Added ability to disable/enable individual rules with a single click without deleting them. Each rule now displays a toggle indicator (✓ for active, ✗ for disabled) in the schedule column, allowing flexible rule management.
- When creating a schedule for a rule, it automatically becomes active to ensure the schedule works as expected.
### Changed
- Enhanced rule management UI with clearer visual feedback for rule status.
- Increased the maximum number of rules available for free users from 5 to 10.

### [3.4.4] - 2026-03-29
### Patch
- Fixed permission check function call in the worker.
- Improved stability of permission handling.

## [3.4.3] - 2026-03-25
### Changed
- Increased the maximum number of rules available for free users to 5.

## [3.4.2] - 2026-03-22
### Added
- Added shouldSkipSync function to prevent redundant server requests when the browser is opened frequently.
### Patch
- Improved sync efficiency and reduced unnecessary network traffic.

## [3.4.1] - 2026-03-15
### Added
- Added translation key "clearstats" for all locales.

## [3.4.0] - 2026-03-13
### Added
- Added a utility function to generate a support page URL that includes contextual information such as the browser and extension version.

## [3.3.3] - 2026-03-11
### Added
- Added a new translation key for cleaning the statistics.

## [3.3.2] - 2026-03-07
### Changed
- Moved the `IS_FIREFOX` constant from the worker script to `utils` for better reuse and organization.

## [3.3.1] - 2026-03-07
### Changed
- Moved the logic for generating the uninstall feedback page URL to a separate script in `utils`.

## [3.3.0] - 2026-03-03
### Added
- Added an uninstall feedback page (`uninstall.html`) that opens automatically when the extension is removed from the browser.

## [3.2.7] - 2026-02-09
### Improved
- When creating a new rule from the popup, focus is now automatically set to the URL input field for faster rule entry.

## [3.2.6] - 2026-02-07
### Added
- Added a new `constants.js` file to the `utils` directory to centralize shared constants.

## [3.2.5] - 2026-02-05
### Improved
- When creating a new blocking/redirect rule, focus is automatically set to the URL input field for faster input.

## [3.2.4] - 2026-01-15
### Changed
- Reduced the maximum number of rules available for free users to 3.

## [3.2.3] - 2026-01-10
### Changed
- The license synchronization status in the Pro section on the settings page is now displayed using localized messages.

## [3.2.2] - 2026-01-08
### Added
- Added missing translation keys across all locales.

## [3.2.1] - 2026-01-07
### Added
- Added a new translation key for handling errors related to communication with the background service.

## [3.2.0] - 2026-01-07
### Added
- Added Debug Mode on the settings page for Pro users.

### Changed
- Refactored the logger into a class-based implementation.
- Logger now includes contextual information and timestamps.
- Improved console output formatting with colored context labels for better readability during debugging.

## [3.1.2] - 2026-01-06
### Changed
- Reworked the rules and settings import implementation for better reliability.
- Made the "delete_all_rules" message listener in the worker asynchronous for improved control flow.

## [3.1.1] - 2026-01-05
### Added
- Added a new translation key "errorinvalidfiletype" across all locales.

## [3.1.0] - 2026-01-05
### Improved
- Enhanced the rule import functionality with file extension validation to prevent loading binary or unsupported files.
- Added explicit error generation for invalid file types to improve clarity.
- Introduced a descriptive error message when the imported file type does not match the expected format.

## [3.0.2] - 2026-01-04
### Changed
- On the settings page, when creating a new rule, free users now see an "Available in Pro" placeholder in the schedule section instead of an empty space.

## [3.0.1] - 2025-12-29
### Fixed
- Moved bulk rule deletion from the settings page to the worker to ensure more reliable and consistent rule cleanup.

## [3.0.0] - 2025-12-24
### Added
- Fully implemented Pro mode with all related features, restrictions, and protections.

## [2.19.9] - 2025-12-24
### Fixed
- Fixed an issue where the password was not being reset properly.

## [2.19.8] - 2025-12-22
### Fixed
- Fixed an issue where declarativeNetRequest rules were not properly cleared during bulk rule deletion.

## [2.19.7] - 2025-12-20
### Fixed
- Fixed a COOP-related issue that prevented proper navigation and login when opening the support website from the extension settings page.

## [2.19.6] - 2025-12-19
### Changed
- Updated the logic for creating blocking rules:
  - Manually entered rules now preserve the path as fully as possible.
  - Rules created via the instant block button are limited to the domain.
  - When blocking via the context menu:
    - Links are blocked using the full URL (same as manual input).
    - Pages are blocked at the domain level (same as instant block).

## [2.19.5] - 2025-12-19
### Changed
- Simplified the feedback sending logic: it is now unified for all browsers and uses a direct link click instead of an iframe.

## [2.19.4] - 2025-12-18
### Fixed
- Fixed an issue in Pro mode where blocking a link from the context menu could incorrectly block the current page instead of the link URL.

## [2.19.3] - 2025-12-18
### Fixed
- Fixed an issue where blocking did not trigger correctly from the page context menu.
- Fixed creation of malformed rules when handling non-standard URLs.

## [2.19.2] - 2025-12-17
### Fixed
- Updated the feedback sending logic to better handle Firefox Mobile specifics.

## [2.19.1] - 2025-12-16
### Fixed
- Changed the way the email application is opened for sending feedback, ensuring a smoother and more reliable experience.

## [2.19.0] - 2025-12-15
### Added
- Introduced a centralized Logger with support for different modes (e.g. debug/production) to control logging behavior.

## [2.18.19] - 2025-12-15
### Changed
- Added a JSDoc comment to the `isBlockedURL` function to improve documentation and code clarity.

## [2.18.18] - 2025-12-14
### Fixed
- Password input is now cleared after logout.
- Added required resources for the intermediate redirect page to the manifest.

## [2.18.17] - 2025-12-14
### Fixed
- Fixed an incorrect function call responsible for creating the context menu in the worker.

## [2.18.16] - 2025-12-14
### Changed
- The worker now validates Pro access based on the license key status instead of the subscription expiration date.

## [2.18.15] - 2025-12-11
### Changed
- Added DevTools to the list of pages that cannot be blocked, ensuring stable extension behavior and preventing interference with browser debugging tools.

## [2.18.14] - 2025-12-09
### Changed
- Rewritten the logic for opening the options page from the popup to ensure more consistent and reliable behavior.

## [2.18.13] - 2025-12-09
### Added
- Added default icons to the "action" key in the manifest.

## [2.18.12] - 2025-12-08
### Fixed
- Adjusted styling in `options.css` to improve layout and visual consistency.

## [2.18.11] - 2025-12-07
### Changed
- Refactored `options.js` to improve structure, readability, and maintainability.

## [2.18.10] - 2025-12-06
### Added
- Added password protection (when a password is set) to prevent bulk deletion of rules and clearing of statistics in the settings page under Pro mode.

## [2.18.9] - 2025-12-06
### Removed
- Removed outdated and unused translation keys from all locales.

## [2.18.8] - 2025-12-05
### Fixed
- Updated and refined styling on the settings page for improved UI consistency.

## [2.18.7] - 2025-12-02
### Fixed
- Improved the UI of the password modal window.

## [2.18.6] - 2025-12-01
### Added
- Added new translation keys related to Pro status synchronization and password updates across all locales.

## [2.18.5] - 2025-12-01
### Added
- Added a "Privacy Secured" badge to the bottom of the popup interface.

## [2.18.4] - 2025-11-30
### Changed
- Updated password reset logic: resetting the password now requires entering the user's license key.

## [2.18.3] - 2025-11-30
### Fixed
- Added mandatory password check before logout to prevent disabling parental control without authorization.
- When a password is set, logging out now always requires password confirmation.

## [2.18.2] - 2025-11-29
### Fixed
- Fixed an issue where the Pro activation input permanently retained the entered license key.

## [2.18.1] - 2025-11-28
### Fixed
- Corrected several translation errors across multiple locales.

## [2.18.0] - 2025-11-25
### Added
- Tabs whose URLs match the added or edited rules in the settings page are now closed instantly.

## [2.17.16] - 2025-11-25
### Changed
- Tab closing for newly created blocking rules is now handled from the worker for more consistent behavior.

## [2.17.15] - 2025-11-24
### Fixed
- Fixed the translation function so that the second parameter is now handled correctly.

## [2.17.14] - 2025-11-23
### Added
- Added translation keys "prounlocked" and "licensesynced" for all locales.

## [2.17.13] - 2025-11-23
### Changed
- Rewrote the logic in `goPro.js` to use Promises instead of callbacks, improving readability and maintainability.

## [2.17.12] - 2025-11-23
### Fixed
- Improved settings page behavior: when the pro status changes, a message is now sent to the worker to ensure the context menu updates correctly.

## [2.17.11] - 2025-11-22
### Fixed
- Fixed an issue where the second password input in the modal was not hidden properly.

## [2.17.10] - 2025-11-22
### Added
- Added translation keys for setting and changing the rule protection password across all locales.

## [2.17.9] - 2025-11-20
### Updated
- Updated the "profunctionstext" translation key across all locales.

## [2.17.8] - 2025-11-19
### Fixed
- Updated the logic for rule limits for free (non-legacy) users in the popup.  
  Rule deletion is now always allowed; only creation of new rules is restricted.

## [2.17.7] - 2025-11-17
### Added
- Added 10 new motivational quotes.

## [2.17.6] - 2025-11-16
### Added
- Added translation keys for the "blocked" page across all locales.

## [2.17.5] - 2025-11-16
### Added
- Enabled internationalization on the "blocked" page.
- Added new translation keys to the English locale.

## [2.17.4] - 2025-11-07
### Added
- Added new translation keys related to authorization across all locales.

## [2.17.3] - 2025-11-07
### Fixed
- Improved styles on the settings page for a cleaner look.
- Fixed the logout functionality — it now works as expected.

## [2.17.2] - 2025-11-06
### Fixed
- Expanded the statistics system — it now collects data not only about blocked sites but also about redirects.

## [2.17.1] - 2025-11-06
### Fixed
- Fixed issues affecting the operation of the statistics collection system.

## [2.17.0] - 2025-11-05
### Added
- Added the ability to reset the blocking password (Pro feature).
### Fixed
- Improved modal styles and fixed issues affecting its behavior.
- Rewritten message listener in the background worker to prevent premature closure of the communication channel.

## [2.16.20] - 2025-11-03
### Fixed
- Corrected several inaccurate translations in the Japanese locale.
- Fixed a delay in updating the UI after activating Pro — changes now apply instantly.

## [2.16.19] - 2025-11-03
### Fixed
- Completed all missing translation keys for all locales.

## [2.16.18] - 2025-11-02
### Fixed
- Improved styles and markup for the Pro activation section on the settings page.
- Added a missing localization key in `messages.json`.
- Updated `content_security_policy` to allow the background worker to communicate with **blockdistraction.com** for license verification.

## [2.16.17] - 2025-10-31
### Fixed
- Improved the `onInstalled` event logic in the background worker:
  - Prevents the updates page from appearing unnecessarily after installation or update.
  - Ensures settings are properly refreshed even if the data access permission was previously revoked.

## [2.16.16] - 2025-10-29
### Fixed
- Added conditional checks to prevent calling APIs that may be unavailable in older browser versions, improving compatibility.
- Fixed a localization key related to the message explaining how to manually grant the required permission.

## [2.16.15] - 2025-10-29
### Fixed
- Onboarding page now closes automatically after the required permission is granted, using a message sent to the background worker.

## [2.16.14] - 2025-10-29
### Added
- Added a check for the required `all_urls` permission during extension setup.
- If the permission is missing, a onboarding page now explains the issue and guides users to enable it manually.

## [2.16.13] - 2025-10-28
### Fixed
- Updated client-side logic for fetching Pro status from the server to ensure more consistent behavior.

## [2.16.12] - 2025-10-27
### Fixed
- Added left padding to text inputs for improved visual appearance.

## [2.16.11] - 2025-10-09
### Fixed
- Fixed tab closing logic for newly created blocking rules.
- If all tabs would be closed, a blank tab is now opened first to prevent the browser from shutting down.

## [2.16.10] - 2025-10-06
### Fixed
- Improved styles on the settings page:
  - Alternating rows now have darker background for better contrast.
  - Increased spacing between action buttons to prevent accidental taps on mobile.

## [2.16.9] - 2025-10-06
### Fixed
- Fixed an issue with integrity checking of declarativeNetRequest rules.

## [2.16.8] - 2025-10-05
### Changed
- Rewritten styles for the blocked page.
- Introduced variables and reduced duplicated CSS rules.

## [2.16.7] - 2025-10-05
### Changed
- Rewritten styles for the popup and settings page.
- Introduced variables and reduced duplicated CSS rules.

## [2.16.6] - 2025-10-04
### Fixed
- Completed all missing translation keys for all locales.

## [2.16.5] - 2025-10-03
### Added
- Added functionality to get Pro access directly from the settings page.

## [2.16.4] - 2025-10-02
### Fixed
- Fixed styles for the rules table on the options page.

## [2.16.3] - 2025-09-30
### Fixed
- Text inputs no longer accept spaces, preventing errors when creating rules.

## [2.16.2] - 2025-09-30
### Fixed
- Completed all missing translation keys for all locales.

## [2.16.1] - 2025-09-29
### Added
- Filtering by categories.
- Filtering by site name.

### Fixed
- Improved and corrected styles for categories.

## [2.16.0] - 2025-09-27
### Added
- Introduced categories for rules: `social`, `news`, `entertainment`, `shopping`, `work`, and `uncategorized`.
- Added automatic migration: all existing rules are now assigned a category (default `uncategorized`).

## [2.15.6] - 2025-09-24
### Fixed
- Completed all missing translation keys for all locales.

## [2.15.5] - 2025-09-23
### Fixed
- Schedule generation now uses day names according to the current locale instead of English.

## [2.15.4] - 2025-09-22
### Fixed
- Completed all missing translation keys for all locales.

## [2.15.3] - 2025-09-21
### Fixed
- Minor corrections in translations

## [2.15.2] - 2025-09-21
### Fixed
- Corrected several translation keys in the English locale.

## [2.15.1] - 2025-09-20
### Fixed
- Reviewed and updated permissions and restrictions for different user types.

## [2.15.0] - 2025-09-19
### Added
- Pro users can now set schedules for rules.

## [2.14.2] - 2025-09-18
### Fixed
- Allowed deletion of non-empty but unsaved rules.

## [2.14.1] - 2025-09-18
### Fixed
- Completed all missing translation keys for all locales.

## [2.14.0] - 2025-09-18
### Added
- Password protection for deleting rules in Pro mode

## [2.13.1] - 2025-09-17
### Fixed
- Minor corrections in translations

## [2.13.0] - 2025-09-16
### Added
- In **Pro mode**, users now have access to a context menu option that allows blocking sites from links with a single click.

## [2.12.12] - 2025-09-15
### Fixed
- Resolved an issue that caused errors when attempting to delete an empty rule in the popup.

## [2.12.11] - 2025-09-15
### Changed
- Editing rules is now restricted for non-legacy users.

## [2.12.10] - 2025-09-14
### Added
- New fields in credentials: `isLegacyUser` and `installationDate`.

## [2.12.9] - 2025-09-13
### Fixed
- The popup now closes automatically when the settings page is opened.

## [2.12.8] - 2025-09-13
### Fixed
- Resolved an issue where the "Block This Site" button in the popup could duplicate after rules were updated on the settings page.

## [2.12.7] - 2025-09-13
### Fixed
- Improved synchronization: when rules are changed in `RulesManager`, both the popup and the settings page now update automatically.

## [2.12.6] - 2025-09-13
### Changed
- Refactored `ProManager` to work in the background worker context without UI dependency.

### Added
- New function in the worker to update Pro status programmatically.

## [2.12.5] - 2025-09-09
### Fixed
- Completed missing translation keys for all locales

## [2.12.4] - 2025-09-02
### Added
- On mobile devices, the "Block current site" button now shows the domain name of the site.

## [2.12.3] - 2025-09-02
### Changed
- Popup now opens the options page via programmatic call instead of a direct link.

## [2.12.2] - 2025-09-02
### Fixed
- Rules list now updates correctly on the options page when using Pro functions.

##[2.12.1] - 2025-09-01
### Fixed
- Width of options page

## [2.12.0] - 2025-09-01
### Added
- New **Statistics system**:
  - Collects data via `tabs` API for accurate tracking.
  - Stored in `storage.local` for speed and reliability.
  - Automatically displayed on the settings page.
  - Daily auto-reset of statistics.
  - Integration with import/export system.
  - Clear statistics (Pro mode only).

## [2.11.3] - 2025-08-31
### Changed
- Rewritten initialization of settings for more reliable startup.
- Default settings are now automatically applied after extension updates.
- Background worker updated to properly check and handle settings.

### Added
- Internal system for **Pro status management** (preparation for future features).

## [2.11.2] - 2025-08-31
### Fixed
- Completed missing translation keys for all locales

## [2.11.1] - 2025-08-30
### Changed
- Updated and refined styles on the options page for improved readability and visual consistency.

## [2.11.0] - 2025-08-29
### Added
- **Security Mode indicator** in the popup — always visible for quick reference.
- Popup now **auto-updates** when extension settings change.

## [2.10.2] - 2025-08-29
### Added
- New locale: **or**
- Updated translations for existing locales to improve clarity and consistency

## [2.10.1] - 2025-08-29
### Changed
- Refactored `popup.js` and `options.js` to class-based structure.
- Moved rule creation logic into new **RulesManager** class.
- Moved DOM interactions (inputs & buttons for rules) into new **RulesUI** class.
- Updated background worker to use **RulesManager**.

### Added
- **validateDnrIntegrity()** — checks consistency between stored rules and DNR rules, detects desynchronization, and triggers resync if needed.

### Improved
- Reduced code duplication across scripts.
- Increased overall stability and maintainability.

## [2.10.0] - 2025-08-28
### Added
- **Strict mode** — prevents accidental deletion of rules.
- **Option to disable update notifications** for the extension.
- **Pro features groundwork** — import/export of rules now available.
- **Basic statistics** on the options page (total rules, blocked sites count, etc.).

## [2.9.1] - 2025-08-24
### Fixed
- Completed missing translation keys for all locales

## [2.9.0] - 2025-08-24
### Changed
- Optimized logic for managing blocking rules with declarativeNetRequest.
- Removed reliance on storage change listener: rules are now handled locally in popup/settings.
- Improved performance: only the new or deleted rule is updated instead of reloading all rules.
- Ensured consistency: storage is updated only if DNR rule creation succeeds.
- Rules are automatically refreshed on browser restart and kept in sync across devices.

## [2.8.6] - 2025-08-21

### Changed
- Updated translations across all 53 supported locales
- Applied branding refresh to extension texts

## [2.8.5] - 2025-08-19

### Fixed
- Completed missing translation keys across multiple locales (es, fr, hr, hu, id, ja, kn, ko, lt, lv, mr, ms, nl, no, pl, ro, ru, sk, sl, sr, sv, sw, ta, te, th, tr, vi), ensuring consistent internationalization support.

## [2.8.4] - 2025-08-18

### Fixed
- Fixed incorrect argument usage in the `closeTabsMatchingRule` function, ensuring rules close tabs as expected.
- Corrected translation handling so that messages with placeholders are properly processed.
- Improved translation logic in `options.js` for more consistent behavior.

### Changed
- Added `name` attributes to all auto-generated input fields to improve accessibility and compatibility with form validation.
- Added `scope` attributes to all table headers (`<th>`) for better accessibility support.

## [2.8.3] - 2025-08-17

### Fixed
- Fixed options.html.

## [2.8.2] - 2025-08-17

### Fixed
- Fixed options.js.

## [2.8.1] - 2025-08-17

### Added
- Added a link in the popup to quickly access the web extension's settings page.

## [2.8.0] - 2025-08-16

### Added
- Options page for managing blocked sites with a full-screen interface.
- View, edit, add, and delete rules directly from the options page.
- Consistent styling with popup and localization support.
- Reused validation logic from popup for block and redirect URLs.

### Changed
- Improved rule management by allowing edits without requiring deletion and re-creation.
- Updated manifest.json to include options_ui configuration.

## [2.7.1] - 2025-08-10

### Changed
- Updated translation for locale: Horatian (hr).

## [2.7.0] - 2025-08-09

### Added
- Added an "Updates" page that is automatically opened when the extension is updated from the store.

## [2.6.25] - 2025-08-01

### Fixed
- Fixed an error that occurred when the script attempted to close a tab that was not created by it, which is restricted by the browser. Second attempt.

## [2.6.24] - 2025-08-01

### Fixed
- Fixed an error that occurred when the script attempted to close a tab that was not created by it, which is restricted by the browser.

## [2.6.23] - 2025-08-01

### Fixed
- Fixed a Content Security Policy (CSP) violation caused by the favicon request.

## [2.6.22] - 2025-08-01

### Changed
- Updated translation for locale: Hungarian (hu).

## [2.6.21] - 2025-07-27

### Changed
- Updated content security policy in manifest.

## [2.6.20] - 2025-07-18

### Changed
- Updated translation for locale: Kannada (kn).

## [2.6.19] - 2025-07-16

### Changed
- Updated translation for locale: Lithuanian (lt).

## [2.6.18] - 2025-07-09

### Changed
- Updated translation for locale: Latvian (lv).

## [2.6.17] - 2025-07-04

### Changed
- Updated translation for locale: Marathi (mr).

## [2.6.16] - 2025-06-28

### Changed
- Updated translation for locale: Malay(ms).

## [2.6.15] - 2025-06-27

### Changed
- Updated translation for locale: Nederland (nl).

## [2.6.14] - 2025-06-26

### Changed
- Updated translation for locale: Norwegian (no).

## [2.6.13] - 2025-06-23

### Changed
- Updated translation for locale: Polish (pl).

## [2.6.12] - 2025-06-21

### Changed
- Updated translation for locale: Romanian (ro).

## [2.6.11] - 2025-06-20

### Changed
- Updated translation for locale: Russian (ru).

## [2.6.10] - 2025-06-19

### Changed
- Updated translation for locale: Slovakian (sk).

## [2.6.9] - 2025-06-18

### Changed
- Updated translation for locale: Slovenian (sl).

## [2.6.8] - 2025-06-16

### Changed
- Improve readability in popup.js by extracting locale messages retrieval into a separate function.

## [2.6.7] - 2025-06-15

### Changed
- Updated translation for locale: Serbian (sr).

## [2.6.6] - 2025-06-14

### Changed
- Updated translation for locale: Swedish (sv).

## [2.6.5] - 2025-06-13

### Changed
- Updated translation for locale: Swahili (sw).

## [2.6.4] - 2025-06-12

### Changed
- Updated translation for locale: Tamil (ta).

## [2.6.3] - 2025-06-10

### Changed
- Updated translation for locale: Telugu (te).

## [2.6.2] - 2025-06-09

### Changed
- Updated translations for locales: Thai (th), Turkish (tr), and Vietnamese (vi).

## [2.6.1] - 2025-06-08

### Changed
- Made `normalizeUrlFilter` function exportable; it is now imported as a module instead of being loaded via a `<script>` tag in HTML.
- Improved code modularity and maintainability.

## [2.6.0] - 2025-06-04
### Added
- New motivational quotes feature: displays motivational messages in the popup.
- Initial support for motivational quotes in 12 languages:
  - English (en)
  - Ukrainian (uk)
  - German (de)
  - Spanish (es)
  - French (fr)
  - Indonesian (id)
  - Japanese (ja)
  - Korean (ko)
  - Portuguese (Brazil) (pt_BR)
  - Portuguese (Portugal) (pt_PT)
  - Chinese (Simplified) (zh_CN)
  - Chinese (Traditional) (zh_TW)

## [2.5.1] - 2025-06-02
### Changed
- Fixed list of web accessible resources.
- Patch version update.

## [2.5.0] – 2025-06-02
### Added
- Custom "blocked" page shown when a website is blocked, instead of the browser's default error message.
- Improved user experience with a clean and neutral message when accessing a blocked site.

## [2.4.1] - 2025-06-01

### Changed
- Updated translations for locales: Lithuanian (lt).
- Patch version update.

## [2.4.0] - 2025-05-31
### Changed
- Added new utility function `closeMatchingTabs(blockURL)` to close all tabs matching the blocked URL.
- Replaced duplicated logic in rule creation and "Block This Site" button with a call to the new function.
- Improved modularity and consistency of tab-handling logic.

## [2.3.4] - 2025-05-30

### Changed
- Updated translations for locales: Indonesian (id), and Kannada (kn).
- Patch version update.

## [2.3.3] - 2025-05-28

### Changed
- Updated `normalizeUrlFilter` function: now only the hostname is stored as the blocking URL, excluding `www` and pathnames.

## [2.3.2] - 2025-05-27

### Fixed
- Refactored `makeInputReadOnly` function: input fields with rules are now selectable and copyable.
- Improved UX when interacting with readonly inputs.

## [2.3.1] - 2025-05-26

### Changed
- Updated translations for locales: Filipino (fil), Gujarati (gu), Hebrew (he), Hindi (hi), Croatian (hr), and Hungarian (hu).
- Patch version update.

## [2.3.0] - 2025-05-25

### Fixed
- Fixed an issue where, after reinstalling the extension with an existing list of blocked sites, declarative network request (DNR) rules were not recreated, causing the blocking to be inactive until the list was manually edited.
- DNR rules are now automatically created during installation (`onInstalled.reason === "install"`) if a `rules` list already exists in storage.

### Added
- Support for modular service workers (`type: "module"`) in Manifest V3

## [2.2.6] - 2025-05-24

### Changed
- Updated translations for locales: Czech (cs), Danish (da), Greek (el), Estonian (et), Persian (fa), and Finnish (fi).
- Patch version update.

## [2.2.5] - 2025-05-23

### Changed
- Updated translations for locales: Africaan (af), Amharic (am), Arabic (ar), Bulgarian (bg), Bengali (bn), and Catalonian (ca).
- Minor version update.

## [2.2.4] - 2025-05-22

### Changed
- Updated translations for locales: Spanish (es), French (fr), Italian (it), Japanese (ja), Korean (ko), and Turkish (tr).
- Minor version update.

## [2.2.3] - 2025-05-21

### Changed
- Refactored the creation of declarative rules into a separate asynchronous function to improve modularity and maintainability.

### Fixed
- Minor internal improvements and code cleanup.

## [2.2.2] - 2025-05-20

### Added
- Title attributes to the control buttons.

## [2.2.1] - 2025-05-18

### Changed
- Automatically includes browser and extension version info in the email subject and body.

## [2.2.0] - 2025-05-17

### Added
- Site favicon is now displayed next to the "Block this site" button
- `favIconUrl` parameter added to `createBlockThisSiteButton` for better visual integration

### Fixed
- Fixed potential errors when handling `favIconUrl` if it's missing from the tab

## [2.1.0] - 2025-05-15
### Added
- Added a "Send Feedback" button to the popup for easy email feedback submissions.

### Changed
- Updated popup styles to support the new button with an SVG icon that changes color on hover.

## [2.0.1] - 2025-05-14

### Changed
- Updated UI translations for the following locales: de, en_CA, en_GB, pt_BR, pt_PT, ru, uk, zh_CN, zh_TW

## [2.0.0] - 2025-05-13

### Added
- "Block this site" button for quick rule creation
- Support for partial keyword-based URL blocking
- Fully responsive layout for popup UI

### Changed
- Major UI redesign for improved clarity and usability
- Smarter rule validation and feedback on save
- Popup layout adapts to browser width (horizontal/vertical input alignment)

### Fixed
- Rules no longer fail silently when invalid URLs are entered
- Fixed dynamic rules not applying in some edge cases
- Corrected fallback behaviors for invalid `tabs` access

### Removed
- Deprecated synchronous tab query logic in favor of async-safe alternatives

## [1.39.5] - 2025-04-xx

- Minor UI adjustments
- Fix for inconsistent rule loading in some browser versions
