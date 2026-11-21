import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openToolbarPopup, readerView, toolbarCount, until } from './popup-probes.mjs';

const click = (page, selector) => page.locator ? page.locator(selector).click() : page.click(selector);
const select = (page, value) => page.locator ? page.locator('#focus-cycle-type').selectOption(value) : page.select('#focus-cycle-type', value);
const catalog = locale => JSON.parse(readFileSync(new URL(`../_locales/${locale}/messages.json`, import.meta.url), 'utf8'));
const ready = view => until(() => view.evaluate(v => v.document.body?.classList.contains('ready') && v.document.getElementById('add-rule')?.disabled === false), Boolean, 'menu ready');

function geometry(v) {
  const d = v.document, root = d.documentElement, body = d.body.getBoundingClientRect();
  return { viewport: v.innerWidth, client: root.clientWidth, origin: root.getBoundingClientRect().left + root.clientLeft, scroll: root.scrollWidth,
    body: { width: body.width, left: body.left, right: body.right },
    surface: d.body.dataset.popupSurface || 'page',
    controls: [...d.querySelectorAll('input, select, button')].map(node => {
      const r = node.getBoundingClientRect();
      return { id: node.id || node.className, left: r.left, right: r.right, width: r.width };
    }).filter(r => r.width > 1) };
}
function assertPageFits(value) {
  assert.ok(value.body.width <= 1201, `menu exceeds its cap: ${JSON.stringify(value)}`);
  assert.ok(value.scroll <= value.client + 1, `horizontal page overflow: ${JSON.stringify(value)}`);
  assert.ok(Math.abs(value.body.left - (value.origin + (value.client - value.body.width) / 2)) <= 1, 'menu is centered');
  assert.ok(value.controls.every(r => r.left >= value.origin - 1 && r.right <= value.origin + value.client + 1),
    `a control leaves the viewport: ${JSON.stringify(value)}`);
}
async function evidence(e, label, value) {
  if (e.result) (e.result.popupLayoutEvidence ||= {})[label] = value;
  if (e.testInfo) await e.testInfo.attach(label, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

export const popupLayoutScenarios = [{
  id: '101', title: 'Main menu navigation keeps wide tabs centered and narrow translated Pomodoro fields inside the viewport',
  async run(e) {
    await e.seed({ pro: true, rules: [{ id: 201, blockURL: 'menu-layout.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] }] });
    const page = await e.openOptions();
    await click(page, '.options-back-link');
    await until(() => page.evaluate(() => location.pathname), value => value === '/index.html', 'real Options-to-Main navigation');
    const view = readerView(page);
    await ready(view);
    await until(() => view.evaluate(v => !v.document.getElementById('focus-session-section').classList.contains('hidden')), Boolean, 'Focus available with a saved rule');
    const initial = await page.evaluate(async () => {
      const api = globalThis.browser || chrome, tab = await api.tabs.getCurrent();
      return { tabId: tab.id, zoom: await api.tabs.getZoom(tab.id) };
    });
    const measured = [];
    try {
      for (const zoom of [1, 2]) {
        await page.evaluate(async ({ tabId, zoom }) => (globalThis.browser || chrome).tabs.setZoom(tabId, zoom), { tabId: initial.tabId, zoom });
        await until(() => page.evaluate(async tabId => (globalThis.browser || chrome).tabs.getZoom(tabId), initial.tabId), value => value === zoom, 'native menu zoom');
        const value = await view.evaluate(geometry);
        assertPageFits(value);
        assert.equal(value.surface, 'page', 'a tab must not use toolbar sizing');
        measured.push({ zoom, ...value });
      }
      await page.evaluate(async initial => (globalThis.browser || chrome).tabs.setZoom(initial.tabId, 1), initial);
      // Real same-origin documents exercise CSS at widths larger than the CI
      // display. These are layout probes, not Android device emulation.
      for (const [width, locale] of [[320, 'en'], [360, 'en'], [390, 'de'], [390, 'ar'],
        [800, 'en'], [1200, 'en'], [1920, 'en'], [2560, 'en']]) {
        await page.evaluate(width => {
          const frame = document.createElement('iframe'); frame.id = '__bdMenuLayout';
          frame.style.cssText = `display:block;border:0;width:${width}px;height:1000px`;
          frame.src = new URL('index.html', location.href).href;
          document.body.append(frame);
        }, width);
        const frame = { evaluate(fn, input = null) {
          return page.evaluate(new Function('input', `return (${fn.toString()})(document.getElementById('__bdMenuLayout').contentWindow, input);`), input);
        } };
        await ready(frame);
        await frame.evaluate(v => { const select = v.document.getElementById('focus-cycle-type');
          select.value = 'pomodoro'; select.dispatchEvent(new v.Event('change', { bubbles: true })); });
        if (locale !== 'en') await frame.evaluate((v, { locale, messages }) => {
          v.document.documentElement.lang = locale;
          v.document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
          for (const node of v.document.querySelectorAll('[data-i18n]')) {
            const message = messages[node.dataset.i18n]?.message;
            if (message) node.innerText = message;
          }
        }, { locale, messages: catalog(locale) });
        const value = await frame.evaluate(geometry);
        assert.equal(value.viewport, width, 'real frame viewport matches the CSS probe');
        assertPageFits(value);
        assert.equal(value.surface, 'page');
        if (width >= 1200) assert.ok(value.body.width >= Math.min(1200, value.client) - 1, 'wide menu uses its available capped width');
        measured.push({ width, locale, ...value });
        await page.evaluate(() => document.getElementById('__bdMenuLayout').remove());
      }
      // A real editor action remains usable after Main menu navigation.
      await select(page, 'single');
      await click(page, '#add-rule');
      await until(() => page.evaluate(() => Boolean(document.querySelector('.rule-editor-row .save-btn'))), Boolean, 'menu editor opens');
      assertPageFits(await view.evaluate(geometry));
    } finally {
      await page.evaluate(async initial => {
        document.getElementById('__bdMenuLayout')?.remove();
        await (globalThis.browser || chrome).tabs.setZoom(initial.tabId, initial.zoom);
      }, initial);
      await evidence(e, 'menu-tab-layout', measured);
    }
  }
}, {
  id: '102', nativeToolbar: true, title: 'Genuine toolbar popup retains a useful width with an empty list and after reopening with rules',
  async run(e) {
    const measured = [];
    for (const populated of [false, true]) {
      await e.seed({ pro: true, rules: populated ? [{ id: 201, blockURL: 'long-address.bd-e2e.test/path', redirectURL: '',
        category: 'social', isWhitelist: false, assignments: [{ listId: 'general', disabledByUser: false,
          blockingMode: 'always', schedule: null, dailyLimit: null }] }] : [] });
      const host = await e.openOptions();
      const chromium = await host.evaluate(() => Boolean((globalThis.browser || chrome).runtime.getManifest().background?.service_worker));
      const popup = await openToolbarPopup(host);
      try {
        await ready(popup);
        await until(() => popup.evaluate(v => v.document.body.dataset.popupSurface), value => value === 'toolbar', 'native desktop layout selected');
        // A random quote must not change the layout fixture between runs.
        await popup.evaluate(v => { const api = v.browser || v.chrome;
          v.document.getElementById('motivational-quote').textContent = api.i18n.getMessage('quote1'); });
        let signature, stableSince = Date.now();
        const settled = await until(async () => {
          const value = await popup.evaluate(geometry), next = JSON.stringify(value);
          if (next !== signature) { signature = next; stableSince = Date.now(); }
          return { value, stable: Date.now() - stableSince >= 300 };
        }, sample => sample.stable, 'native popup autosizing settled');
        const value = settled.value;
        assert.ok(value.viewport > 0 && value.viewport <= 800, `native popup width: ${JSON.stringify(value)}`);
        if (chromium) assert.ok(value.viewport >= 359 && value.viewport <= 380, 'Chromium keeps its compact preferred width');
        else if (populated) assert.ok(value.viewport >= 600, 'Firefox retains its wide native popup with rules');
        assertPageFits(value);
        measured.push({ populated, chromium, ...value });
      } finally {
        await popup.evaluate(v => v.close());
        await until(() => toolbarCount(host), value => value === 0, 'native popup closed');
      }
    }
    await evidence(e, 'native-toolbar-layout', measured);
  }
}];
