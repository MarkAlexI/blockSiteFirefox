# Block Site Extension: Website Time Management

![GitHub license](https://img.shields.io/github/license/MarkAlexI/blockSiteExtension)
![GitHub stars](https://img.shields.io/github/stars/MarkAlexI/blockSiteExtension?style=social)
![GitHub forks](https://img.shields.io/github/forks/MarkAlexI/blockSiteExtension?style=social)
![Last commit](https://img.shields.io/github/last-commit/MarkAlexI/blockSiteExtension)
![Issues](https://img.shields.io/github/issues/MarkAlexI/blockSiteExtension)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-v5.1.22-brightgreen?logo=google-chrome)](https://chromewebstore.google.com/detail/kfhgdgokgjmdboidlhphajinmgpcmmec)
[![AMO](https://img.shields.io/amo/v/blockersite)](https://addons.mozilla.org/uk/firefox/addon/blockersite/)

## About
An extension that will block or redirect requests in browser used `declarativeNetRequest` for generating dynamic rules.

## Development checks

The repository uses only the built-in Node.js test runner and standard-library tools. No dependency installation is required.

```bash
npm test
npm run test:coverage
npm run validate
npm run check
```

- `npm test` runs the unit and service-worker smoke tests.
- `npm run test:coverage` reports native Node.js source coverage for the complete test suite.
- `npm run validate` checks JavaScript syntax, JSON files, manifest references, version consistency, and English localization keys referenced by the code.
- `npm run check` runs the complete pre-release verification.

Node.js 20 or newer is required.

## Installation

The `main` branch of this repository contains a ready-to-use package for installation in Google Chrome (Developer Mode) — simply click the "<> Code" button then click "Download ZIP" to download the package. No build or additional steps are required.

Alternatively, you can use the release packages provided.

For a more convenient installation, use the official stores:
- [Chrome Web Store](https://chromewebstore.google.com/detail/kfhgdgokgjmdboidlhphajinmgpcmmec)
- [Mozilla Add-ons (AMO)](https://addons.mozilla.org/uk/firefox/addon/blockersite/)
- [Edge Add-ons Store](https://microsoftedge.microsoft.com/addons/detail/ilmfjlfmilmafofbanphijmbklbmolhi)

Both versions work on mobile browsers:
- **Kiwi Browser** for the Chrome version
- **Firefox Mobile** for the Firefox version
- **Edge Mobile** for the Edge version

![blocker.png](/images/blocker.png "blocker")
## How to work with extension
To block a website or resource, enter part of its name into the input field with the placeholder "Type Block URL" — for example, "facebook" will block all related subdomains. In the field with the placeholder "Type Redirect URL", enter the full redirect address including the protocol, such as "https://google.com". If the redirect field is left empty, the site will be blocked without redirection. Click the Save button to apply the rule. To update a rule, delete the old one and create a new entry.
## Video Demo: [Block Site Extension](https://youtu.be/-z3pXiM_yv8?si=vEEBruG6XABppWQs)
### Project Description

This Chrome extension was developed as the final project for the CS50x course from Harvard, implemented using JavaScript. The primary function of the extension is to help users manage their time online by limiting distractions from specific websites. It is publicly available in the [Chrome Web Store](https://chromewebstore.google.com/detail/kfhgdgokgjmdboidlhphajinmgpcmmec) and has successfully passed all verification processes required by Google.

The extension allows users to set rules that control access to certain websites. Users can either block websites entirely or redirect them to another, more productive page. The heart of the extension is the **Manifest V3**, which provides metadata and defines the permissions required by the extension.

---

## Structure and Key Files

### 1. Manifest (`manifest.json`)
The manifest is the cornerstone of the extension. It contains all the necessary metadata and configuration for the Chrome extension. Manifest V3 is a major update by Chrome, providing enhanced security and performance for extensions. This file defines the extension's permissions, such as what kind of data it can access, which scripts can run, and what UI components are used (like popups or background workers). The manifest specifies the following:

- **Name and Description**: Describes the extension's purpose for users.
- **Version**: Tracks the version of the extension for updates.
- **Permissions**: Declares which permissions are needed (more details below).
- **Background Service Worker**: Runs in the background to handle tasks like rule creation or monitoring.
- **Action**: Defines the popup interface (described below) triggered when users click the extension's icon.
- **Icons**: Declares different icon sizes, which are automatically selected by the browser depending on where the icon is displayed (extension bar, context menu, etc.).
- **Default Locale**: Sets the primary language for the extension, enabling internationalization.

### 2. `index.html`
This is the entry point to the extension's user interface. It defines the popup that users interact with. The popup opens when users click the extension's icon in the Chrome toolbar. In the HTML, you'll find the layout of the popup, which includes buttons for adding or removing rules, as well as a list of current access rules.

### 3. `popup.css`
Contains the styling rules for the popup interface. The design is minimalist, focusing on usability with a clean and functional layout. By avoiding excessive visual elements, the extension remains lightweight and easy to navigate. CSS styles define the appearance of buttons, text input fields, and the list of websites users are managing.

### 4. `popup.js`
This script is responsible for handling the popup's interactive elements. When the popup opens, it retrieves and displays the user's device-local saved rules. This allows users to manage rules across different devices. Users can add or remove rules through a simple interface. Whenever a new rule is created, it is stored locally on the current browser installation, and the popup is updated dynamically to reflect the changes.

### 5. `background.js`
A crucial part of the extension, the background script runs continuously in the background and monitors the extension’s storage. It listens for changes and dynamically updates or removes access rules using the `declarativeNetRequest` API, which is part of Manifest V3. This API allows the extension to block or redirect network requests based on user-defined rules without needing full network access permissions. The `background.js` script also handles the creation of redirect rules when the user specifies an alternative URL for blocked sites.

---

## Features

### 1. Site Blocking and Redirection
Users can block any website by adding it to a list in the extension's popup. When a blocked site is visited, the extension prevents it from loading. Users also have the option to set up a redirection to another URL. For instance, if they frequently get distracted by social media, they can redirect themselves to a more productive website whenever they attempt to visit a blocked site.

### 2. Device-local Rules and Rule Lists
Blocking rules are stored locally on each browser installation so the extension does not need an account or a cloud rule database. Pro and legacy users can create named Rule List profiles such as Work or Study. One profile is active at a time, and the same target can have a different Always, Schedule, or Daily Limit assignment in each profile. General is the default profile.

### 3. Blocking Modes and Daily Limits
Each active-profile assignment has one clear blocking mode: Always, Schedule, or Daily limit. Schedule and Daily limit cannot be enabled at the same time within one assignment. The same target can therefore use different schedules or limits in General, Work, Study, or other profiles without inactive profiles affecting the current result. Pro and legacy users can set a Daily limit to allow a matching site for a defined number of visible foreground minutes per local calendar day. Once the active profile budget is exhausted, the existing DNR engine blocks the target. Daily usage stays on the device and is not included in rule exports or telemetry.

### 4. Minimalist User Interface
The extension's interface is designed for simplicity. The popup window provides an intuitive experience where users can quickly view, add, or delete rules for specific websites. There's no clutter—just straightforward functionality.

### 5. Internationalization (i18n)
The extension supports multiple languages through the `chrome.i18n` API. The extension currently ships 57 locale directories with translated interface strings. The `_locales` folder contains subfolders for each supported language, with `messages.json` files that provide translations for the extension's text elements. The browser automatically detects the user’s language settings and displays the appropriate translation. The `i18n.js` file simplifies the process of populating the popup with the correct text in each language.

### 6. Dynamic Rule Management
The background script, in combination with the `declarativeNetRequest` API, ensures that rules are enforced dynamically. When a user adds a site to be blocked, the extension immediately registers the rule without needing to restart the browser or reload the page.

### 7. Context Menu Design Rationale
The context menu is intentionally minimalistic and silent by design.
It provides a single action — blocking the current site or a selected link — without any confirmations, notifications, or visible feedback.
This behavior is deliberate: the extension acts as an infrastructure tool rather than an interactive assistant. A user-initiated click is treated as a final decision, and the effect (blocking and closing matching tabs) is applied immediately.
On mobile platforms, context menus are not supported by browsers; therefore, this functionality is unavailable there by design. This limitation is documented on the support page, and no fallback UI is shown to avoid feature duplication or user confusion.
The context menu logic supports both page-level and link-level blocking through a single menu item, ensuring consistent behavior and avoiding silent no-op actions.

---

## Icons

The extension includes several icons in different sizes, located in the `images` directory. These icons are defined in the manifest and are used in different contexts:

- **16x16**: Displayed in the browser’s tab bar.
- **48x48**: Used in extension management pages.
- **128x128**: Shown in the Chrome Web Store listing.

Chrome automatically selects the appropriate icon size based on where the icon is being used, ensuring a consistent and sharp appearance across all contexts.

---

## Permissions

To function effectively, the extension requires a few specific permissions, which are explicitly declared in the manifest:

### 1. DeclarativeNetRequest
This permission allows the extension to block or redirect network requests without needing access to all of the user's browsing activity. The `declarativeNetRequest` API enhances security by enabling the extension to manage web requests in a more controlled way, reducing privacy risks for users.

### 2. Storage
The `storage` permission is required for storing user-defined rules, Rule Lists, settings, statistics, and other extension state. Blocking rules and Rule Lists are device-local; selected settings use browser sync storage where supported.

---

## Future Improvements

While the current version of the extension is fully functional, several ideas for enhancements are under consideration:

- **Schedules** (implemented):  
   Rules can block during selected days and time periods.

- **Daily Limits** (implemented):  
   Pro rules can allow a matching site for a daily active-use budget and block it after the budget is exhausted.

- **Category-based Blocking** (implemented):  
   Grouping websites into categories (e.g., social media, news) with category blocking state scoped to the active Rule List profile.

- **Detailed Statistics** (implemented):  
   Keeps device-local aggregate counts for blocks, redirects, and completed Focus Sessions, plus a rolling 30-day daily history with 7-day and 30-day charts. Statistics do not store site addresses or browsing history.

- **Rule Lists** (implemented):
   Named Pro profiles such as Work or Study can keep independent blocking modes and category settings for the same targets and are included in rule import/export without requiring a user account.

---

Thank you for using this extension! I hope it helps you stay focused and productive. Feedback and suggestions for improvement are always welcome.
