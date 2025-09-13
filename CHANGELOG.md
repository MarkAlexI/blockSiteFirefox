# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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