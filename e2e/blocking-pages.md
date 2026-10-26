# Blocking and redirect screens — 5.4.15

Prepared by MarkAlexI, 26 October 2026.

## Behavior

Both screens expose a named main landmark. The redirect title and waiting
text use the existing localization module, including native document language
and direction. The spinner is decorative. The initial waiting page is a new
navigation, so it does not add a redundant live announcement.

The blocking page keeps one mounted polite/atomic close-action status.
Its native button stays focusable with aria-disabled while a request is
pending; repeated clicks and held activation keys do not replay it. A failed
request leaves a localized explanation and permits a new explicit action.
No completion callback moves focus. Pagehide invalidates old UI work;
a persisted pageshow starts a new generation without replaying that work.
Only the four own blocking-reason keys select an alternate explanation.

Chromium now uses tabs.getCurrent() followed by tabs.remove() to target the
page's own tab and observe completion/rejection. It does not query whichever
tab happens to be active. Firefox retains close_current_tab through the event
page. That handler keeps its reply channel open until tabs.remove settles,
returns a safe success flag, and tolerates a receiver destroyed by closure.
Failures still pass through its existing async-handler boundary.

The existing shared palette, focus and reduced-motion rules remain in use.
Full-page cards can grow vertically, wrap long messages and keep their
controls within narrow viewports. Rule-table CSS is outside this change.

## Automated coverage

Eleven new Node checks exercise the production blocking-page script and the
native-test fault probe. They cover pending results, duplicate actions,
rejection/throw, explicit retry, later focus, invalid tab/reply values,
pagehide/pageshow generations, allowlisted reasons, markup and all 57 catalogs.
The Firefox worker import tests additionally hold/reject the real handler's
API adapter, check reply ordering and verify invalid/zero tab IDs and a closed
receiver. Existing redirect authorization and page tests continue to pass.

The new contract checks fail on pristine 5.4.14. A separate control removing
only the pending guard also fails the duplicate-request test in both variants.
These Node checks use API/DOM models; they do not establish native tab closure.

Scenario 64 supplies the native check. It is included in the existing
accessibility scenario list and checks:

1. Real DNR navigation to the localized blocking page and its accessible Close
   name, document language and reason.
2. Native Tab/Enter, one pending request, safe failure feedback and later focus.
   Only this API outcome is held/rejected as an explicit UI fault probe.
3. A new native Space action with the original API restored: only the intended
   tab closes; the control tab stays open.
4. A real configured DNR redirect reaches its authorized HTTP destination.
5. The actual waiting screen localizes correctly while delivery of one native
   DNR read is held. Releasing its original result denies the unconfigured
   target and navigates to the packaged blocking page.
6. Saved rules and installed DNR rules remain equal before and after the UI
   sequence. No navigation is repeated after an abort: the test still requires
   the exact final destination.

Chrome also exposes browser.*. The fixture's known target chooses the close
fault probe, and a Node regression covers both namespaces being present.
The last waiting probe uses the existing background-realm test helper;
Firefox preload scripts are not used to intercept privileged page startup.

## Local results and limits

- Root npm run check: **2204/2204** Node tests, extension validation and
  all **70** palette contrast checks passed.
- Firefox Developer Edition **158.0b2**, build **20260930090528**,
  geckodriver **0.37.1**, Linux headless, disposable persistent unsigned install:
  scenario **64 passed** on the Firefox target. Native close and both real
  DNR transitions passed. Waiting/error delivery controls are labelled above.
- Separate Firefox renderer checks passed at **325 CSS px**, native tab zoom
  **200%**, long translated RTL text, forced colors and reduced motion.
  Horizontal overflow was absent; native Tab exposed the close control and its
  outline. Locale text/direction changes in this layout probe are explicit
  fixtures, not acceptance of all browser UI languages or screen-reader speech.
  Measurements followed two animation frames after zoom/style changes.
- Chrome for Testing **151.0.7922.34** was downloaded from the official host;
  full archive size and ZIP CRCs were verified. Its native process stopped
  before the scenario body at ProcessSingleton AF_UNIX socket creation:
  **Operation not permitted**. This is a blocked local Chromium setup, not a
  passing Chromium run or a reproduced extension assertion failure.
- Full browser suites, actual Android/TalkBack, macOS, minimum browser versions
  and store-signed installation were not run for this change. Desktop DOM,
  computed accessibility and keyboard evidence do not establish speech output.

## Run

From the extension root:

```sh
npm run check
```

From e2e/, with its locked dependencies and the usual browser setup:

```sh
npm test -- --filter=64
```

Use npm run test:headed -- --filter=64 in a normal desktop/Xvfb environment.
The local run used the pinned browser/driver, persistent unsigned install and
headless mode. MOZ_DISABLE_CONTENT_SANDBOX=1 was required only for its child
process in this container. Personal profiles were not used.
Inventory is now **63** Firefox Desktop scenarios. A filtered run explicitly
sets completeSuite=false and does not confirm the entire suite.

## Device acceptance

On Firefox Android, use a disposable test setup to open a normally blocked
site, read its reason, reach Close by TalkBack and double-tap it. Check focus
and browser behavior after closure. Check a long translation, large text and
both orientations. Test a configured redirect and a denied/unavailable
background path separately; record the browser/OS and observed result.

On desktop, also check keyboard Close with another browser window active.
Failure feedback should stay visible, preserve later focus and allow one new
explicit request. Do not substitute a click replay or a longer timeout for
investigating a failed assertion.

## References

- [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [MDN tabs.remove](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/remove)
- [WCAG status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- [WCAG language of page](https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html)
- [MDN prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion)

A [December 2020 discussion](https://stackoverflow.com/questions/65403070/what-is-the-equivalent-command-to-close-for-chrome-runtime-openoptionspage)
includes woxxom's advice to use tabs.remove with the document's current tab
as an alternative to window.close, and distinguishes tab-less contexts. It is
historical context, not evidence of a present Edge defect. The current API
contract and the checks above determine this patch's behavior.
