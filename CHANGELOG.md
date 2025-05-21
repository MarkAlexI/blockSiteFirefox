# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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