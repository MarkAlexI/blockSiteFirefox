# WECG retained-document and iframe-menu regression probes

These test-only probes keep the extension version unchanged. They use the real
runtime, a headed Firefox, a disposable profile and synthetic loopback sites.
They run as extra Linux CI steps: #617 in the upgrade lane, #1195 in core. Their
reports live below e2e/test-results/wecg and are included in existing artifacts.

## Retained matching document (#617)

After preparing the existing pinned baselines with
`node e2e/prepare-upgrade-baseline.mjs`, run:

```bash
BD_WECG_CASE=617 xvfb-run -a node e2e/wecg-native-probe.mjs
```

By default this uses the latest configured pinned baseline. To test a particular
previous unpacked runtime, set BD_WECG_PREVIOUS_EXTENSION_PATH to its directory.
The probe checks an actual native update event with the real previous version,
unchanged document timeOrigin, an independent DOM marker and unsaved input.
Normal native tab activation then exercises the existing programmatic visibility
observer; a subsequent real visibility transition must deliver the extension
message and increase the preserved Daily Limit budget without a document reload.
The report separately retains first-cycle events: the test does not assume the
new observer existed before the first native post-update activation. It uses
temporary development addons and does not verify store signing or distribution.

## Cross-origin iframe context menu (#1195)

```bash
BD_WECG_CASE=1195 xvfb-run -a node e2e/wecg-native-probe.mjs
```

A real A document embeds B, whose link points to C. Browser-native permission
storage withholds A/B host access and grants only C. A negative scripting probe
must fail for B. WebDriver right-clicks the link and selects the real extension
menu item. The native event must identify C and the child frame; production code
must save C's normalized path, leave A open and make a fresh C navigation hit
native DNR. Passive browser activity tracing must show no scripting.executeScript
call by the menu action. This does not rely on an activeTab grant.

A desktop DISPLAY is required (xvfb-run plus Openbox on Linux). Standard
BD_FIREFOX_BINARY and BD_GECKODRIVER apply. BD_EXTENSION_PATH can select a
packaged current runtime; BD_WECG_RESULTS selects an output directory.

The ordinary npm test suite also exercises the production menu worker with
cross-origin OnClickData while scripting and additional permission requests are
forbidden. API-model tests do not establish native permission or menu behavior.
