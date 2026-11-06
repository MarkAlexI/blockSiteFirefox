import assert from 'node:assert/strict';
import { until, openToolbarPopup } from './popup-probes.mjs';

// An extension page in window A can observe a full-page Popup in that window
// without foregrounding it. All browser APIs and production handlers stay real.
function popupView(host, url) {
  return { evaluate(fn, input = null) {
    return host.evaluate(new Function('input', `
      const api = globalThis.browser || chrome;
      const view = api.extension.getViews().find(view => view.location.href === ${JSON.stringify(url)});
      if (!view) return null;
      return (${fn.toString()})(view, input);`), input);
  } };
}

export async function reloadPopupDocument(view, expectedRows) {
  const previousToken = await view.evaluate(v =>
    v.__bdTabTargetDocumentToken ||= v.crypto.randomUUID());
  assert.ok(previousToken, 'the Popup document exists before reload');
  await view.evaluate(v => v.location.reload());
  return until(() => view.evaluate(v => ({
    token: v.__bdTabTargetDocumentToken ||= v.crypto.randomUUID(),
    ready: v.document.readyState === 'complete',
    rows: [...v.document.querySelectorAll('.rule[data-rule-id]')].filter(row => row.dataset.ruleId !== 'null').length,
    button: Boolean(v.document.getElementById('block-that'))
  })), value => value?.token !== previousToken && value?.ready && value.rows === expectedRows,
  'a new Popup document finished rendering the saved rules');
}

export const popupTabTargetScenarios = [{
  id: '75', nativeDesktop: true, nativeToolbar: true,
  title: 'Popup preserves its displayed target across two windows and never offers to block its own extension tab',
  async run(e) {
    await e.seed({ pro: false, rules: [] });
    const host = await e.openOptions();
    const observed = { fullPagePopup: true, mobileDevice: false, phases: [] };
    let otherWindowId, popupId;
    try {
      const created = await host.evaluate(async () => {
        const api = globalThis.browser || chrome;
        const own = await api.tabs.getCurrent();
        const target = await api.tabs.create({ windowId: own.windowId,
          url: 'http://popup-target-a.bd-e2e.test/start', active: true });
        const other = await api.windows.create({ url: 'http://popup-target-b.bd-e2e.test/start', focused: true });
        return { target, otherWindowId: other.id, otherTabId: other.tabs[0].id };
      });
      otherWindowId = created.otherWindowId;
      await until(() => host.evaluate(async created => {
        const api = globalThis.browser || chrome;
        const target = await api.tabs.get(created.target.id), other = await api.tabs.get(created.otherTabId);
        const window = await api.windows.get(created.otherWindowId);
        return { target, other, focused: window.focused };
      }, created), value => value.focused && value.target.status === 'complete' && value.other.status === 'complete',
      'two real windows with A active in the caller window and B focused elsewhere');
      const query = await host.evaluate(async () => {
        const api = globalThis.browser || chrome;
        const { getCurrentTabs } = await import(api.runtime.getURL('scripts/getCurrentTabs.js'));
        return getCurrentTabs();
      });
      assert.deepEqual(query.map(tab => tab.id), [created.target.id], 'production getter resolves its own window, not last-focused B');

      const url = e.popupUrl + '?tab-target=' + Date.now();
      const popupTab = await host.evaluate(async ({ url, windowId }) => {
        const api = globalThis.browser || chrome;
        return api.tabs.create({ url, windowId, active: false });
      }, { url, windowId: created.target.windowId });
      popupId = popupTab.id;
      const view = popupView(host, url);
      const displayed = await until(() => view.evaluate(v => ({
        title: v.document.getElementById('block-that')?.title,
        ready: v.document.readyState === 'complete'
      })), value => value?.ready && value.title?.includes('popup-target-a.bd-e2e.test'), 'Popup displays A from its own window');
      const focused = await host.evaluate(async id => (await (globalThis.browser || chrome).windows.get(id)).focused, otherWindowId);
      assert.equal(focused, true, 'observing the Popup did not focus A instead of B');
      await view.evaluate(v => v.document.getElementById('block-that').click());
      await until(async () => (await e.state()).rules.map(rule => rule.blockURL),
        urls => urls.length === 1 && urls[0] === 'popup-target-a.bd-e2e.test', 'displayed A is the only stored rule');
      const saved = await e.state();
      assert.equal(saved.rules.some(rule => rule.blockURL.includes('popup-target-b')), false);
      const survivor = await host.evaluate(async id => (await (globalThis.browser || chrome).tabs.get(id)).url, created.otherTabId);
      assert.equal(survivor, 'http://popup-target-b.bd-e2e.test/start');
      observed.phases.push({ kind: 'background full-page Popup', displayed, selectedTabId: query[0].id, savedTarget: saved.rules[0].blockURL });

      await host.evaluate(async ({ tabId, windowId }) => {
        const api = globalThis.browser || chrome;
        await api.tabs.update(tabId, { active: true });
        await api.windows.update(windowId, { focused: true });
      }, { tabId: popupId, windowId: created.target.windowId });
      const reloaded = await reloadPopupDocument(view, 1);
      assert.equal(reloaded.button, false,
        'an extension tab is protected, without falling back to B');
      observed.phases.push({ kind: 'active extension tab', blockThisSite: false });

      const toolbar = await openToolbarPopup(host);
      await until(() => toolbar.evaluate(v => [...v.document.querySelectorAll('.rule[data-rule-id]')]
        .filter(row => row.dataset.ruleId !== 'null').length), count => count === 1, 'genuine toolbar Popup rendered');
      assert.equal(await toolbar.evaluate(v => Boolean(v.document.getElementById('block-that'))), false,
        'toolbar opened over Options must not borrow a web target from another window');
      observed.phases.push({ kind: 'genuine toolbar over protected Options', blockThisSite: false });
      await e.assertBlocked('http://popup-target-a.bd-e2e.test/after-popup-save');
      assert.deepEqual((await e.state()).rules, saved.rules);
    } finally {
      if (e.testInfo) await e.testInfo.attach('popup-tab-target', { contentType: 'application/json', body: JSON.stringify(observed, null, 2) });
      else e.result.popupTabTarget = observed;
      await host.evaluate(async ({ popupId, otherWindowId }) => {
        const api = globalThis.browser || chrome;
        if (popupId !== undefined) await api.tabs.remove(popupId).catch(() => {});
        if (otherWindowId !== undefined) await api.windows.remove(otherWindowId).catch(() => {});
      }, { popupId, otherWindowId });
    }
  }
}];
