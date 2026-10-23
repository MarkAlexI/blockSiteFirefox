import assert from 'node:assert/strict';
async function poll(read, check, label) {
  const deadline = Date.now() + 15_000;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

const press = (page, key) => page.keyboard ? page.keyboard.press(key) : page.press(key);
const focus = (page, selector) => page.evaluate(selector => document.querySelector(selector).focus(), selector);

export const accessibilityScenarios = [{
  id: '48',
  title: 'Options disclosures and named rule controls support native keyboard input and hidden panels leave Tab order',
  async run(e) {
    const page = await e.openOptions();
    const panels = await page.evaluate(() => [...document.querySelectorAll('.collapsible-toggle')]
      .map(button => button.getAttribute('aria-controls')));
    assert.equal(panels.length, 7);
    for (const [index, id] of panels.entries()) {
      const selector = `.collapsible-toggle[aria-controls="${id}"]`;
      const expanded = index >= 5;
      assert.equal(await page.evaluate(id => document.getElementById(id).hidden, id), !expanded);
      await focus(page, selector);
      if (expanded) await press(page, 'Space');
      await press(page, 'Enter');
      assert.equal(await page.evaluate(id => document.getElementById(id).hidden, id), false);
      assert.equal(await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded'), selector), 'true');
      await press(page, 'Tab');
      assert.equal(await page.evaluate(id => document.getElementById(id).contains(document.activeElement), id), true,
        `${id}: Tab reaches an expanded panel control`);
      await press(page, 'Shift+Tab');
      assert.equal(await page.evaluate(selector => document.activeElement.matches(selector), selector), true);
      await press(page, 'Space');
      assert.equal(await page.evaluate(id => document.getElementById(id).hidden, id), true);
      assert.equal(await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded'), selector), 'false');
      await press(page, 'Tab');
      assert.equal(await page.evaluate(id => document.getElementById(id).contains(document.activeElement), id), false,
        `${id}: collapsed panel leaves Tab order`);
    }

    // A draft survives closing the Rule Lists panel; no create/save mutation.
    await focus(page, '[aria-controls="rule-lists-panel"]');
    await press(page, 'Enter');
    if (page.locator) await page.locator('#rule-list-name-input').fill('KeyboardDraft');
    else await page.fill('#rule-list-name-input', 'KeyboardDraft');
    await focus(page, '[aria-controls="rule-lists-panel"]');
    await press(page, 'Space');
    await press(page, 'Enter');
    assert.equal(await page.evaluate(() => document.getElementById('rule-list-name-input').value), 'KeyboardDraft');
    await focus(page, '#add-rule');
    await press(page, 'Enter');
    await poll(() => page.evaluate(() => !!document.querySelector('#rules-container .blocking-mode-select')), Boolean, 'named rule editor');
    const labels = await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const row = document.querySelector('#rules-container tr:has(.save-btn)');
      return { category: row.querySelector('td:nth-child(3) select').getAttribute('aria-label'),
        mode: row.querySelector('.blocking-mode-select').getAttribute('aria-label'),
        expected: [api.i18n.getMessage('category_header'), api.i18n.getMessage('blockingmode_header')] };
    });
    assert.deepEqual([labels.category, labels.mode], labels.expected);
    if (page.getByRole) {
      for (const name of labels.expected) assert.equal(await page.locator('#rules-container tr:has(.save-btn)').getByRole('combobox', { name, exact: true }).count(), 1);
    } else {
      assert.equal(await (await page.element('#rules-container tr:has(.save-btn) td:nth-child(3) select')).getAccessibleName(), labels.category);
      assert.equal(await (await page.element('#rules-container .blocking-mode-select')).getAccessibleName(), labels.mode);
    }

    const popup = await e.openPopup();
    if (popup.front) await popup.front(); else await popup.bringToFront();
    await poll(() => popup.evaluate(() => document.body.classList.contains('ready')), Boolean, 'popup ready');
    assert.deepEqual(await popup.evaluate(() => {
      const button = document.getElementById('options-link');
      const scroll = document.getElementById('scrollToTopBtn');
      return [button.tagName, button.type, scroll.hidden, scroll.getAttribute('aria-label').length > 1];
    }), ['BUTTON', 'button', true, true]);
    // Real scroll + observer + trusted keyboard activation, without adding rules.
    await popup.evaluate(() => { document.body.style.minHeight = '2200px'; window.scrollTo(0, 1500); });
    await poll(() => popup.evaluate(() => !document.getElementById('scrollToTopBtn').hidden), Boolean, 'scroll button visible');
    await popup.evaluate(() => {
      window.__bdScrollFocus = [];
      for (const type of ['focusin', 'focusout', 'click']) document.addEventListener(type, event => {
        window.__bdScrollFocus.push({ type, target: event.target.id, trusted: event.isTrusted,
          active: document.activeElement?.id, hidden: document.getElementById('scrollToTopBtn').hidden });
      }, true);
    });
    await focus(popup, '#scrollToTopBtn');
    await press(popup, 'Enter');
    await poll(() => popup.evaluate(() => document.documentElement.scrollTop === 0), Boolean, 'returned to top');
    assert.equal(await popup.evaluate(() => document.activeElement.id), 'options-link',
      JSON.stringify(await popup.evaluate(() => window.__bdScrollFocus)));
    await poll(() => popup.evaluate(() => document.getElementById('scrollToTopBtn').hidden), Boolean, 'scroll button hidden');
  }
}, {
  id: '52',
  title: 'Rule state and chart day controls support native keyboard activation, retained focus and visual RTL arrows',
  async run(e) {
    const rule = { id: 52, blockURL: 'keyboard-toggle.bd-e2e.test', redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] };
    await e.seed({ pro: true, rules: [rule] });
    const page = await e.openOptions();
    const toggle = '#rules-container tr[data-rule-id="52"][data-assignment-list-id="general"] .rule-toggle';
    const names = await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      return { toggle: `${api.i18n.getMessage('blockingmode_header')}: keyboard-toggle.bd-e2e.test`,
        blocked: api.i18n.getMessage('totalblockedlabel'), redirected: api.i18n.getMessage('totalredirectslabel') };
    });
    const assertName = async (selector, name, role = 'button') => {
      if (page.getByRole) assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1);
      else assert.equal(await (await page.element(selector)).getAccessibleName(), name);
    };
    assert.equal(await page.evaluate(selector => document.querySelector(selector).tagName, toggle), 'BUTTON');
    await assertName(toggle, names.toggle);
    const assertToggle = async disabled => {
      await poll(() => page.evaluate(async ({ selector, disabled }) => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        const stored = (await api.storage.local.get('rules')).rules.find(rule => rule.id === 52);
        const button = document.querySelector(selector);
        return stored.assignments[0].disabledByUser === disabled &&
          button?.getAttribute('aria-pressed') === String(!disabled) && document.activeElement === button;
      }, { selector: toggle, disabled }), Boolean, 'saved toggle state and replacement focus');
      await assertName(toggle, names.toggle);
    };
    await focus(page, toggle);
    await press(page, 'Space'); await assertToggle(true);
    await press(page, 'Enter'); await assertToggle(false);

    // Newly keyboard-reachable disabling still goes through the real password gate.
    await focus(page, '[aria-controls="security-settings-panel"]'); await press(page, 'Enter');
    await focus(page, '#enablePassword'); await press(page, 'Space');
    await poll(() => page.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'password setup');
    const fill = (selector, value) => page.locator ? page.locator(selector).fill(value) : page.fill(selector, value);
    const password = 'BD-keyboard-rule-52';
    await fill('#passwordInput1', password); await fill('#passwordInput2', password); await press(page, 'Enter');
    await poll(() => page.evaluate(() => !document.getElementById('passwordModal').open), Boolean, 'password saved');
    await focus(page, toggle); await press(page, 'Space');
    await poll(() => page.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'toggle password gate');
    await press(page, 'Escape'); await assertToggle(false);
    await press(page, 'Enter');
    await poll(() => page.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'toggle password retry');
    await fill('#passwordInput1', password); await press(page, 'Enter'); await assertToggle(true);

    await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const now = new Date(), previous = new Date(now); previous.setDate(previous.getDate() - 1);
      const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      await api.storage.local.set({ statistics: { lastResetDate: now.toDateString(), totalBlocked: 10, blockedToday: 7,
        totalRedirects: 3, redirectsToday: 2, successfulFocusSessions: 5, dailyHistory: {
          [key(previous)]: { blocked: 3, redirected: 1, focusSessions: 2 },
          [key(now)]: { blocked: 7, redirected: 2, focusSessions: 3 }
        } } });
    });
    await focus(page, '[aria-controls="statistics-panel"]'); await press(page, 'Enter');
    await focus(page, '[data-stat-range="7"]'); await press(page, 'Enter');
    await poll(() => page.evaluate(() => document.querySelectorAll('#statsActivityChart .stats-chart-column').length),
      count => count === 7, 'seven chart buttons');
    const day = index => `#statsActivityChart .stats-chart-column:nth-child(${index + 1})`;
    const selected = async index => assert.equal(await page.evaluate(selector => document.activeElement === document.querySelector(selector) &&
      document.activeElement.getAttribute('aria-checked') === 'true', day(index)), true);
    await focus(page, day(6));
    assert.equal(await page.evaluate(selector => document.querySelector(selector).tagName, day(6)), 'BUTTON');
    const summary = await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-label'), day(6));
    assert.ok(summary.includes(`${names.blocked}: 7`) && summary.includes(`${names.redirected}: 2`));
    await assertName(day(6), summary, 'radio');
    if (!page.getByRole) assert.equal(await (await page.element(day(6))).getAriaRole(), 'radio');
    await page.evaluate(() => {
      window.__bdChartActivations = [];
      document.getElementById('statsActivityChart').addEventListener('click', event => {
        if (event.target.closest('.stats-chart-column')) window.__bdChartActivations.push(event.isTrusted);
      });
    });
    await press(page, 'Space'); await press(page, 'Enter');
    assert.deepEqual(await page.evaluate(() => window.__bdChartActivations), [true, true]);
    await press(page, 'ArrowLeft'); await selected(5);
    assert.equal(await page.evaluate(() => document.querySelector('#statsActivityChart .stats-chart-detail').textContent),
      await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-label'), day(5)));
    await press(page, 'Home'); await selected(0);
    await press(page, 'End'); await selected(6);
    await press(page, 'ArrowDown'); await selected(0);
    await press(page, 'ArrowUp'); await selected(6);
    await press(page, 'Tab');
    assert.equal(await page.evaluate(() => document.getElementById('statsFocusChart').contains(document.activeElement)), true);
    await press(page, 'Shift+Tab'); await selected(6);
    const originalDirection = await page.evaluate(() => document.documentElement.dir);
    try {
      await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
      const left = await page.evaluate(() => document.activeElement.getBoundingClientRect().left);
      await press(page, 'ArrowRight'); await selected(5);
      assert.ok(await page.evaluate(() => document.activeElement.getBoundingClientRect().left) > left, 'RTL Right moves visually right');
      await press(page, 'ArrowLeft'); await selected(6);
    } finally { await page.evaluate(dir => { document.documentElement.dir = dir; }, originalDirection); }
    assert.equal(await page.evaluate(() => document.querySelectorAll('#statsActivityChart .stats-chart-column[tabindex="0"]').length), 1);
  }
}, {
  id: '53',
  nativeViewport: true,
  nativeDesktop: true,
  title: 'Browser zoom at 200 percent preserves compact rule editing, schedule geometry and dialog actions',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    const initial = await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const tab = await api.tabs.getCurrent();
      const window = await api.windows.get(tab.windowId);
      return { tabId: tab.id, windowId: tab.windowId, zoom: await api.tabs.getZoom(tab.id),
        width: window.width, height: window.height, dpr: devicePixelRatio };
    });
    const fill = (selector, value) => page.locator ? page.locator(selector).fill(value) : page.fill(selector, value);
    const select = value => page.locator ? page.locator('#rules-container .blocking-mode-select').selectOption(value)
      : page.select('#rules-container .blocking-mode-select', value);
    const activate = async selector => { await focus(page, selector); await press(page, 'Enter'); };
    const dialogFits = selector => page.evaluate(selector => {
      const dialog = document.querySelector(selector), r = dialog.getBoundingClientRect();
      return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 &&
        dialog.scrollWidth <= dialog.clientWidth + 1;
    }, selector);
    try {
      await page.evaluate(async initial => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        await api.windows.update(initial.windowId, { state: 'normal', width: 640, height: 960 });
        await api.tabs.setZoom(initial.tabId, 2);
      }, initial);
      await poll(() => page.evaluate(() => innerWidth), width => width >= 280 && width <= 340, 'real zoomed narrow viewport');
      const zoom = await page.evaluate(async tabId => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        return { factor: await api.tabs.getZoom(tabId), dpr: devicePixelRatio, innerWidth,
          bodyWidth: document.body.getBoundingClientRect().width,
          lang: document.documentElement.lang, dir: document.documentElement.dir,
          nativeLocale: api.i18n.getMessage('@@ui_locale').replace(/_/g, '-'), nativeDirection: api.i18n.getMessage('@@bidi_dir') };
      }, initial.tabId);
      assert.equal(zoom.factor, 2);
      assert.ok(Math.abs(zoom.dpr - initial.dpr * 2) < 0.05);
      assert.ok(zoom.bodyWidth <= zoom.innerWidth + 1, 'Options body fits the real zoomed viewport');
      assert.equal(zoom.lang, zoom.nativeLocale);
      assert.equal(zoom.dir, zoom.nativeDirection);

      await activate('#add-rule');
      await poll(() => page.evaluate(() => !!document.querySelector('#rules-container .blocking-mode-select')), Boolean, 'rule editor');
      await fill('#rules-container td:nth-child(1) input', 'zoom-layout.bd-e2e.test/path');
      assert.equal(await page.evaluate(() => document.querySelector('#rules-container td:nth-child(1) input').dir), 'ltr');
      await select('daily_limit');
      await fill('#rules-container .daily-limit-minutes', '1440');
      assert.equal(await page.evaluate(() => document.querySelector('#rules-container .daily-limit-minutes').value), '1440');
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#rules-container .actions button')].every(button => {
        const r = button.getBoundingClientRect(), cell = button.closest('td').getBoundingClientRect();
        return r.left >= cell.left - 1 && r.right <= cell.right + 1 && button.scrollWidth <= button.clientWidth + 1;
      })), true, 'editor action labels fit their own compact cell');

      await select('schedule');
      await activate('#rules-container .schedule-edit-button');
      await poll(() => page.evaluate(() => !!document.querySelector('.schedule-dialog[open]')), Boolean, 'zoomed schedule');
      await activate('.schedule-add-period');
      assert.equal(await dialogFits('.schedule-dialog'), true);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.schedule-period-days')]
        .every(grid => grid.scrollWidth <= grid.clientWidth + 1)), true, 'all day groups fit their cards');
      assert.equal(await page.evaluate(() => document.activeElement.closest('fieldset') === document.querySelectorAll('.schedule-period-card')[1]), true);
      await press(page, 'Escape');
      assert.equal(await page.evaluate(() => document.activeElement.matches('.schedule-edit-button')), true);
      assert.equal(await page.evaluate(() => document.querySelector('#rules-container td:nth-child(1) input').value), 'zoom-layout.bd-e2e.test/path');
      await select('daily_limit');
      await activate('#rules-container .save-btn');
      await poll(() => page.evaluate(async () => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        const rules = (await api.storage.local.get('rules')).rules;
        const saved = rules.filter(rule => rule.blockURL === 'zoom-layout.bd-e2e.test/path');
        return saved.length === 1 && saved[0].assignments[0].blockingMode === 'daily_limit' && saved[0].assignments[0].dailyLimit.minutes === 1440;
      }), Boolean, 'one explicit rule commit with retained daily limit');

      await activate('#open-rule-packs');
      assert.equal(await dialogFits('#rule-packs-dialog'), true);
      await press(page, 'Escape');
      await activate('[aria-controls="security-settings-panel"]');
      await focus(page, '#enablePassword'); await press(page, 'Space');
      await poll(() => page.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'zoomed password dialog');
      assert.equal(await dialogFits('#passwordModal'), true);
      await press(page, 'Escape');
    } finally {
      await page.evaluate(async initial => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        await api.tabs.setZoom(initial.tabId, initial.zoom);
        await api.windows.update(initial.windowId, { width: initial.width, height: initial.height });
      }, initial);
    }
  }
}];
