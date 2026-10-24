import assert from 'node:assert/strict';
import { statisticsScenarios } from './statistics-scenarios.mjs';
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
}, {
  id: '54',
  title: 'Popup rule toggles expose committed keyboard state, retain assignment focus and respect password and Focus locks',
  async run(e) {
    const rule = id => ({ id, blockURL: `popup-toggle-${id}.bd-e2e.test`, redirectURL: '', category: 'social', isWhitelist: false,
      assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] });
    await e.seed({ pro: true, rules: [rule(54), rule(55)] });
    const page = await e.openPopup();
    const front = async target => { if (target.front) await target.front(); else await target.bringToFront(); };
    await front(page);
    const toggle = '#rules-container .rule[data-rule-id="54"][data-assignment-list-id="general"] .rule-toggle-popup';
    await poll(() => page.evaluate(() => document.querySelectorAll('#rules-container .rule-toggle-popup').length),
      count => count === 2, 'two Popup rule controls');
    assert.equal(await page.evaluate(() => document.querySelector('#rules-container .rule-toggle-popup').tagName), 'BUTTON');
    const name = await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      return `${api.i18n.getMessage('blockingmode_header')}: popup-toggle-54.bd-e2e.test`;
    });
    const assertAccessibleName = async (selector, expected, role = 'button') => {
      if (page.getByRole) {
        await poll(() => page.locator(selector).and(page.getByRole(role, { name: expected, exact: true })).count(), count => count === 1, 'Popup AX name');
      } else {
        await poll(async () => {
          try { return await (await page.element(selector)).getAccessibleName(); }
          catch (error) {
            // The read spans two WebDriver commands while real refreshes replace rows.
            if (error.name === 'StaleElementReferenceError') return null;
            throw error;
          }
        }, actual => actual === expected, 'Popup computed AX name');
      }
    };
    const assertName = () => assertAccessibleName(toggle, name);
    const assertState = async disabled => {
      await poll(() => page.evaluate(async ({ selector, disabled }) => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        const stored = (await api.storage.local.get('rules')).rules.find(rule => rule.id === 54);
        const button = document.querySelector(selector);
        return stored.assignments[0].disabledByUser === disabled && button?.getAttribute('aria-pressed') === String(!disabled) &&
          document.activeElement === button;
      }, { selector: toggle, disabled }), Boolean, 'Popup committed state and replacement focus');
      await assertName();
    };
    await assertName();
    const labels = await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      return [api.i18n.getMessage('blockurl'), api.i18n.getMessage('redirecturl')];
    });
    const rowSelector = '#rules-container .rule[data-rule-id="54"]';
    await assertAccessibleName(`${rowSelector} input:nth-of-type(1)`, labels[0], 'textbox');
    await assertAccessibleName(`${rowSelector} input:nth-of-type(2)`, labels[1], 'textbox');
    await page.evaluate(() => {
      window.__bdPopupToggleClicks = [];
      document.getElementById('rules-container').addEventListener('click', event => {
        if (event.target.closest('.rule-toggle-popup')) window.__bdPopupToggleClicks.push(event.isTrusted);
      });
    });
    await focus(page, toggle); await press(page, 'Space'); await assertState(true);
    await press(page, 'Enter'); await assertState(false);
    assert.deepEqual(await page.evaluate(() => window.__bdPopupToggleClicks), [true, true]);

    const options = await e.openOptions(); await front(options);
    await focus(options, '[aria-controls="security-settings-panel"]'); await press(options, 'Enter');
    await focus(options, '#enablePassword'); await press(options, 'Space');
    await poll(() => options.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'password setup');
    const fill = (target, selector, value) => target.locator ? target.locator(selector).fill(value) : target.fill(selector, value);
    const password = 'BD-popup-toggle-54';
    await fill(options, '#passwordInput1', password); await fill(options, '#passwordInput2', password);
    await press(options, 'Enter');
    await poll(() => options.evaluate(() => !document.getElementById('passwordModal').open), Boolean, 'password saved');
    await front(page); await focus(page, toggle); await press(page, 'Space');
    await poll(() => page.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'Popup password gate');
    await press(page, 'Escape'); await assertState(false);
    await press(page, 'Enter');
    await poll(() => page.evaluate(() => document.getElementById('passwordModal').open), Boolean, 'Popup password retry');
    await fill(page, '#passwordInput1', password); await press(page, 'Enter'); await assertState(true);

    // The newly keyboard-reachable action still follows the real Focus lock.
    await focus(page, '#start-focus-btn'); await press(page, 'Enter');
    await poll(() => page.evaluate(() => document.getElementById('rules-container').classList.contains('focus-lock-active') &&
      [...document.querySelectorAll('.rule-toggle-popup')].every(button => button.disabled)), Boolean, 'Focus locks Popup toggles');
    await focus(page, '#stop-focus-btn'); await press(page, 'Enter');
    await poll(() => page.evaluate(() => !document.getElementById('rules-container').classList.contains('focus-lock-active') &&
      [...document.querySelectorAll('.rule-toggle-popup')].every(button => !button.disabled)), Boolean, 'Focus unlocks Popup toggles');

    // A background refresh respects a later choice of a permanent control.
    await focus(page, '#options-link');
    await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const saved = await api.storage.local.get(['rules', 'rulesGeneration']);
      await api.storage.local.set({ rules: saved.rules.map(rule => rule.id === 54 ? { ...rule,
        assignments: rule.assignments.map(a => ({ ...a, disabledByUser: false })) } : rule), rulesGeneration: `${saved.rulesGeneration}-54-external` });
    });
    await poll(() => page.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', toggle),
      Boolean, 'background rule refresh');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'options-link');
    await focus(page, toggle);
    await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const saved = await api.storage.local.get(['rules', 'rulesGeneration']);
      await api.storage.local.set({ rules: saved.rules.filter(rule => rule.id !== 54), rulesGeneration: `${saved.rulesGeneration}-removed` });
    });
    await poll(() => page.evaluate(() => document.activeElement.id === 'add-rule'), Boolean, 'removed focused rule falls back to Add');
  }
}, {
  id: '55',
  title: 'Popup status notifications announce ordered repeats without moving focus and wait for modal dismissal',
  async run(e) {
    await e.seed({ pro: false, rules: Array.from({ length: 10 }, (_, index) => ({ id: 550 + index, blockURL: `status-${index}.bd-e2e.test`, redirectURL: '', category: 'social', isWhitelist: false, assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] })) });
    const page = await e.openPopup();
    if (page.front) await page.front(); else await page.bringToFront();
    await poll(() => page.evaluate(() => document.body.classList.contains('ready')), Boolean, 'Popup ready');
    assert.deepEqual(await page.evaluate(() => {
      const status = document.getElementById('custom-alert');
      return status ? [status.getAttribute('role'), status.getAttribute('aria-live'),
        status.getAttribute('aria-atomic'), status.textContent, status.hasAttribute('tabindex')] : null;
    }), ['status', 'polite', 'true', '', false], 'an empty status exists before the first message');
    const messages = await page.evaluate(() => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      window.__bdNotices = [];
      window.__bdNoticeFocus = [];
      const status = document.getElementById('custom-alert');
      new MutationObserver(() => window.__bdNotices.push(status.textContent))
        .observe(status, { childList: true, characterData: true, subtree: true });
      document.addEventListener('focusin', event => window.__bdNoticeFocus.push(event.target.id));
      return { invalid: api.i18n.getMessage('rulelimitreached', ['10']), pending: api.i18n.getMessage('ruleschangessavedpending') };
    });
    await focus(page, '#add-rule');
    await page.evaluate(() => {
      window.__bdNoticeFocus = []; window.__bdNoticeClicks = [];
      document.getElementById('add-rule').addEventListener('click', event => window.__bdNoticeClicks.push(event.isTrusted));
    });
    await press(page, 'Enter');
    await press(page, 'Enter');
    // The real Free-limit path above queues identical localized notices. Exercise
    // the existing committed/pending formatter too, without fabricating a save.
    await page.evaluate(async () => {
      const { customAlert } = await import('./scripts/customAlert.js');
      const { getRulesMutationFeedback } = await import('./rules/rulesMutationFeedback.js');
      customAlert(getRulesMutationFeedback({ syncPending: true }, '+ 1').message);
    });
    await poll(() => page.evaluate(() => window.__bdNotices.filter(Boolean).length), count => count >= 1, 'first notification');
    assert.equal(await page.evaluate(() => document.getElementById('custom-alert').textContent), messages.invalid);
    if (page.getByRole) assert.equal(await page.getByRole('status').filter({ hasText: messages.invalid }).count(), 1);
    else assert.equal(await (await page.element('#custom-alert')).getAriaRole(), 'status');
    await poll(() => page.evaluate(() => window.__bdNotices.filter(Boolean).length), count => count >= 2, 'repeated notification');
    assert.deepEqual(await page.evaluate(() => window.__bdNotices.slice(0, 3)), [messages.invalid, '', messages.invalid]);
    await poll(() => page.evaluate(() => document.getElementById('custom-alert').textContent), value => value === messages.pending, 'queued pending result');
    assert.deepEqual(await page.evaluate(() => window.__bdNotices.filter(Boolean)), [messages.invalid, messages.invalid, messages.pending]);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#custom-alert').length), 1);
    assert.deepEqual(await page.evaluate(() => window.__bdNoticeFocus), []);
    assert.deepEqual(await page.evaluate(() => window.__bdNoticeClicks), [true, true]);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'add-rule');
    assert.equal(await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      return !!(await api.storage.local.get('focusSession')).focusSession?.active;
    }), false, 'limit notices do not start Focus');

    await focus(page, '#options-link'); await press(page, 'Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'custom-alert', 'visible notification is keyboard reachable');
    await press(page, 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'options-link');
    await focus(page, '#add-rule');

    // Use the production prompt controller with real eligible storage. The
    // manual Feedback button opens email and is not the prompt entry point.
    await e.writeLocal({ feedbackPromptState: {}, statistics: { totalBlocked: 25, dailyHistory:
      Object.fromEntries([1, 2, 3].map(day => [new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10), { blocked: 1 }])) } });
    assert.equal(await page.evaluate(async () => (await import('./feedback/feedbackPrompt.js')).initFeedbackPrompt()), true);
    await poll(() => page.evaluate(() => document.getElementById('feedback-dialog').open), Boolean, 'Feedback opens');
    await poll(() => page.evaluate(() => document.getElementById('custom-alert').textContent), value => value === '', 'background status waits outside modal');
    await press(page, 'Escape');
    await poll(() => page.evaluate(() => document.getElementById('custom-alert').textContent), value => value === messages.pending, 'pending result resumes after modal');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'add-rule');
    const geometry = await page.evaluate(() => {
      const status = document.getElementById('custom-alert');
      const box = status.getBoundingClientRect();
      return { inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
        overflow: status.scrollWidth > status.clientWidth + 1 };
    });
    assert.deepEqual(geometry, { inside: true, overflow: false });
    await page.goto(await page.url());
    if (page.front) await page.front(); else await page.bringToFront();
    await poll(() => page.evaluate(() => document.body.classList.contains('ready')), Boolean, 'reopened Popup ready');
    assert.deepEqual(await page.evaluate(() => {
      const status = document.getElementById('custom-alert');
      return [status.textContent, status.hasAttribute('tabindex')];
    }), ['', false], 'a new page has no stale notification or empty Tab stop');
  }
}, {
  id: '56',
  title: 'Settings validation retains drafts, protects pending saves and restores keyboard focus with nonblocking status',
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openOptions();
    if (page.front) await page.front(); else await page.bringToFront();
    const nativeDialogs = [];
    if (page.on) page.on('dialog', dialog => nativeDialogs.push(dialog.type()));
    assert.deepEqual(await page.evaluate(() => {
      const status = document.getElementById('custom-alert');
      return status ? [status.getAttribute('role'), status.getAttribute('aria-live'), status.textContent] : null;
    }), ['status', 'polite', ''], 'Options has a persistent empty status before feedback');
    // Real RPCs are forwarded once. A gate delays dispatch; a controlled pending
    // flag exercises UI feedback, not a native DNR synchronization failure.
    await page.evaluate(() => {
      window.__bdRuleWrites = [];
      const originals = [...new Set([globalThis.chrome?.runtime, globalThis.browser?.runtime].filter(Boolean))]
        .map(runtime => [runtime, runtime.sendMessage.bind(runtime)]);
      for (const [runtime, original] of originals) runtime.sendMessage = function(input, ...args) {
        if (!['rules:add', 'rules:update'].includes(input?.type)) return original(input, ...args);
        window.__bdRuleWrites.push({ type: input.type, payload: structuredClone(input.payload) });
        const hold = window.__bdHoldRuleWrite?.type === input.type ? window.__bdHoldRuleWrite : null;
        if (hold) window.__bdHoldRuleWrite = null;
        const gate = hold ? new Promise(resolve => { window.__bdReleaseRuleWrite = resolve; }) : Promise.resolve();
        const finish = response => hold?.pending && response?.success ? { ...response, syncPending: true } : response;
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          if (!hold) return original(input, ...args.slice(0, -1), response => callback(finish(response)));
          gate.then(() => original(input, ...args.slice(0, -1), response => callback(finish(response))));
          return;
        }
        if (!hold) return Promise.resolve(original(input, ...args)).then(finish);
        return gate.then(() => original(input, ...args)).then(finish);
      };
    });
    const editor = '#rules-container .rule-editor-row';
    const block = `${editor} td:nth-child(1) input`, redirect = `${editor} td:nth-child(2) input`;
    const save = `${editor} .save-btn`, daily = `${editor} .daily-limit-minutes`;
    const fill = (selector, value) => page.locator ? page.locator(selector).fill(value) : page.fill(selector, value);
    const activate = async selector => { await focus(page, selector); await press(page, 'Enter'); };
    await activate('#add-rule');
    await fill(redirect, 'ftp://invalid.example'); await activate(save);
    await poll(() => page.evaluate(({ block, redirect }) => {
      const first = document.querySelector(block), second = document.querySelector(redirect);
      return first?.getAttribute('aria-invalid') === 'true' && second?.getAttribute('aria-invalid') === 'true' && document.activeElement === first;
    }, { block, redirect }), Boolean, 'invalid fields are described and the first receives focus');
    const errors = await page.evaluate(({ block, redirect }) => [block, redirect].map(selector => {
      const input = document.querySelector(selector), id = input.getAttribute('aria-describedby');
      return { id, text: document.getElementById(id)?.textContent, value: input.value };
    }), { block, redirect });
    assert.ok(errors.every(field => field.id && field.text)); assert.notEqual(errors[0].id, errors[1].id);
    assert.equal(errors[1].value, 'ftp://invalid.example');
    assert.equal(await page.evaluate(() => document.getElementById('custom-alert').textContent), '', 'focused field errors have no duplicate status');
    await fill(block, 'settings-feedback.bd-e2e.test'); await fill(redirect, '');
    assert.equal(await page.evaluate(selector => document.querySelector(selector).getAttribute('aria-invalid'), redirect), null);
    if (page.select) await page.select(`${editor} .blocking-mode-select`, 'daily_limit');
    else await page.locator(`${editor} .blocking-mode-select`).selectOption('daily_limit');
    await fill(daily, '0'); await activate(save);
    await poll(() => page.evaluate(selector => document.activeElement === document.querySelector(selector) &&
      document.activeElement.getAttribute('aria-invalid') === 'true', daily), Boolean, 'Daily Limit error focuses minutes');
    assert.equal(await page.evaluate(() => window.__bdRuleWrites.length), 1, 'local invalid limit sends no mutation');
    await fill(daily, '15');
    await page.evaluate(() => { window.__bdHoldRuleWrite = { type: 'rules:add', pending: true }; });
    await activate(save); await press(page, 'Enter');
    assert.deepEqual(await page.evaluate(({ editor, block, save }) => [document.querySelector(editor).getAttribute('aria-busy'),
      document.querySelector(save).getAttribute('aria-disabled'), document.querySelector(block).disabled,
      window.__bdRuleWrites.length], { editor, block, save }), ['true', 'true', true, 2]);
    await page.evaluate(() => window.__bdReleaseRuleWrite());
    await poll(async () => (await e.state()).rules.length, count => count === 1, 'one committed rule');
    const pending = await page.evaluate(() => (globalThis.browser || chrome).i18n.getMessage('ruleschangessavedpending'));
    await poll(() => page.evaluate(() => document.getElementById('custom-alert').textContent), text => text === pending, 'successful pending notice');
    await poll(() => page.evaluate(() => document.activeElement.id), id => id === 'add-rule', 'Add regains focus after adding');
    assert.equal(await page.evaluate(() => window.__bdRuleWrites.length), 2, 'pending success sends no retry');
    const rule = (await e.state()).rules[0]; assert.equal(rule.assignments[0].dailyLimit.minutes, 15);
    const saved = `#rules-container tr[data-rule-id="${rule.id}"][data-assignment-list-id="general"]`;
    await activate(`${saved} .rule-edit`);
    await fill(redirect, 'ftp://still-invalid.example'); await activate(save);
    await poll(() => page.evaluate(selector => document.activeElement === document.querySelector(selector) &&
      document.activeElement.getAttribute('aria-invalid') === 'true', redirect), Boolean, 'Edit retains its draft and focuses invalid redirect');
    assert.equal(await page.evaluate(selector => document.querySelector(selector).value, block), 'settings-feedback.bd-e2e.test');
    await fill(redirect, 'https://redirect.example/');
    await page.evaluate(() => { window.__bdHoldRuleWrite = { type: 'rules:update' }; });
    await activate(save); await press(page, 'Enter');
    assert.equal(await page.evaluate(() => window.__bdRuleWrites.filter(entry => entry.type === 'rules:update').length), 2,
      'one rejected Edit and one pending Edit, without duplicate dispatch');
    await focus(page, '#search-input'); await page.evaluate(() => window.__bdReleaseRuleWrite());
    await poll(async () => (await e.state()).rules[0].redirectURL, value => value === 'https://redirect.example/', 'edited rule committed');
    await poll(() => page.evaluate(() => !document.querySelector('.rule-editor-row')), Boolean, 'Edit refresh finished');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'search-input', 'later focus choice survives the response and refresh');
    // A normal applied edit returns to the matching Edit action.
    await activate(`${saved} .rule-edit`); await fill(redirect, ''); await activate(save);
    await poll(() => page.evaluate(selector => document.activeElement === document.querySelector(`${selector} .rule-edit`), saved),
      Boolean, 'Edit regains focus after an applied update');
    assert.equal(await page.evaluate(() => window.__bdRuleWrites.length), 5, 'each Save dispatches at most once');
    assert.deepEqual(nativeDialogs, []);
    if (e.result) assert.equal((e.result.userPrompts || []).filter(event => event.context === page.context && event.type === 'alert').length, 0);
  }
}, {
  id: '57',
  title: 'Popup rule errors retain drafts, guard duplicate Save and preserve useful keyboard focus',
  nativeViewport: true,
  async run(e) {
    await e.seed({ pro: true });
    const page = await e.openPopup();
    if (page.front) await page.front(); else await page.bringToFront();
    await poll(() => page.evaluate(() => document.body.classList.contains('ready')), Boolean, 'Popup ready');
    // Delay each chosen real RPC once; a successful reply's controlled pending
    // flag tests feedback without claiming a native browser synchronization fault.
    await page.evaluate(() => {
      window.__bdPopupWrites = []; window.__bdPopupReplies = [];
      for (const runtime of new Set([globalThis.chrome?.runtime, globalThis.browser?.runtime].filter(Boolean))) {
        const original = runtime.sendMessage.bind(runtime);
        runtime.sendMessage = function(input, ...args) {
          if (input?.type !== 'rules:add') return original(input, ...args);
          window.__bdPopupWrites.push(structuredClone(input.payload));
          const hold = window.__bdHoldPopupWrite; window.__bdHoldPopupWrite = null;
          const gate = hold ? new Promise(resolve => { window.__bdReleasePopupWrite = resolve; }) : Promise.resolve();
          const finish = response => {
            window.__bdPopupReplies.push(structuredClone(response));
            return hold?.pending && response?.success ? { ...response, syncPending: true } : response;
          };
          const callback = args.at(-1);
          if (typeof callback === 'function') {
            if (!hold) return original(input, ...args.slice(0, -1), response => callback(finish(response)));
            gate.then(() => original(input, ...args.slice(0, -1), response => callback(finish(response))));
            return;
          }
          return gate.then(() => original(input, ...args)).then(finish);
        };
      }
    });
    const editor = '#rules-container .rule:has(.save-btn)';
    const block = `${editor} input:nth-of-type(1)`, redirect = `${editor} input:nth-of-type(2)`, save = `${editor} .save-btn`;
    const fill = (selector, value) => page.locator ? page.locator(selector).fill(value) : page.fill(selector, value);
    const activate = async selector => { await focus(page, selector); await press(page, 'Enter'); };
    const add = async (whitelist = false) => {
      await activate(whitelist ? '#add-whitelist-rule' : '#add-rule');
      await poll(() => page.evaluate(selector => Boolean(document.querySelector(selector)), save), Boolean, 'Popup draft inserted');
    };
    const settled = () => poll(() => page.evaluate(() => ({ saved: !document.querySelector('#rules-container .save-btn'),
      draft: document.querySelector('#rules-container .rule:has(.save-btn)')?.textContent,
      lastWrite: window.__bdPopupWrites.at(-1), lastReply: window.__bdPopupReplies.at(-1) })), value => value.saved, 'Popup draft saved');
    await add(); await fill(redirect, 'ftp://invalid.example'); await activate(save);
    await poll(() => page.evaluate(({ block, redirect }) => {
      const a = document.querySelector(block), b = document.querySelector(redirect);
      return a?.getAttribute('aria-invalid') === 'true' && b?.getAttribute('aria-invalid') === 'true' && document.activeElement === a;
    }, { block, redirect }), Boolean, 'Popup validation focuses the first invalid field');
    assert.deepEqual(await page.evaluate(({ block, redirect }) => [block, redirect].map(selector => {
      const input = document.querySelector(selector);
      return [Boolean(document.getElementById(input.getAttribute('aria-describedby'))?.textContent), input.value];
    }), { block, redirect }), [[true, ''], [true, 'ftp://invalid.example']]);
    assert.equal(await page.evaluate(() => document.querySelector('#rules-container .rule-editor-feedback').querySelectorAll('tr,td').length), 0);
    assert.equal(await page.evaluate(() => document.getElementById('custom-alert').textContent), '', 'field descriptions have no duplicate status');
    const initial = await page.evaluate(async () => {
      const api = typeof browser === 'undefined' ? chrome : browser;
      const tab = await api.tabs.getCurrent(), window = await api.windows.get(tab.windowId);
      return { tabId: tab.id, windowId: tab.windowId, zoom: await api.tabs.getZoom(tab.id), width: window.width, height: window.height, dpr: devicePixelRatio };
    });
    try {
      await page.evaluate(async initial => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        await api.windows.update(initial.windowId, { state: 'normal', width: 640, height: 960 });
        await api.tabs.setZoom(initial.tabId, 2);
      }, initial);
      await poll(() => page.evaluate(() => innerWidth), width => width >= 280 && width <= 340, 'Popup at real 200% zoom');
      // Resize changes the existing button transitions too. Wait for the same
      // final geometry within the scenario's existing deadline, without retrying Save.
      const zoom = await poll(() => page.evaluate(async tabId => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        const row = document.querySelector('#rules-container .rule:has(.save-btn)'), feedback = row.querySelector('.rule-editor-feedback');
        const boxes = [row, feedback, ...row.querySelectorAll('input,button')].map(el => {
          const rect = el.getBoundingClientRect();
          return { tag: el.tagName, className: el.className, left: rect.left, right: rect.right,
            scroll: el.scrollWidth, client: el.clientWidth,
            fits: rect.left >= -1 && rect.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1 };
        });
        return { factor: await api.tabs.getZoom(tabId), dpr: devicePixelRatio, innerWidth, boxes, fits: boxes.every(box => box.fits) };
      }, initial.tabId), value => value.factor === 2 && value.fits, 'Popup errors fit after native zoom and resize');
      assert.equal(zoom.factor, 2); assert.ok(Math.abs(zoom.dpr - initial.dpr * 2) < 0.05);
      assert.equal(zoom.fits, true, `Popup field errors and actions fit the native zoomed viewport: ${JSON.stringify(zoom)}`);
    } finally {
      await page.evaluate(async initial => {
        const api = typeof browser === 'undefined' ? chrome : browser;
        await api.tabs.setZoom(initial.tabId, initial.zoom);
        await api.windows.update(initial.windowId, { width: initial.width, height: initial.height });
      }, initial);
    }
    await fill(block, 'popup-feedback.bd-e2e.test'); await fill(redirect, '');
    await page.evaluate(() => { window.__bdHoldPopupWrite = { pending: true }; });
    await activate(save); await press(page, 'Enter');
    assert.deepEqual(await page.evaluate(({ editor, block, save }) => [document.querySelector(editor).getAttribute('aria-busy'),
      document.querySelector(save).getAttribute('aria-disabled'), document.querySelector(block).disabled, window.__bdPopupWrites.length],
    { editor, block, save }), ['true', 'true', true, 2]);
    await page.evaluate(() => window.__bdReleasePopupWrite()); await settled();
    await poll(async () => (await e.state()).rules.length, count => count === 1, 'one committed Popup rule');
    await poll(() => page.evaluate(() => document.activeElement.id), id => id === 'add-rule', 'Add regains focus');
    const pending = await page.evaluate(() => (globalThis.browser || chrome).i18n.getMessage('ruleschangessavedpending'));
    await poll(() => page.evaluate(() => document.getElementById('custom-alert').textContent), text => text === pending, 'Popup pending feedback');
    assert.equal(await page.evaluate(() => window.__bdPopupWrites.length), 2, 'pending feedback never retries a mutation');

    await add(); await fill(block, 'popup-feedback.bd-e2e.test'); await fill(redirect, 'https://retained.example/'); await activate(save);
    await poll(() => page.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-invalid') === 'true', block), Boolean, 'duplicate address field error');
    assert.deepEqual(await page.evaluate(({ block, redirect }) => [document.querySelector(block).value, document.querySelector(redirect).value],
      { block, redirect }), ['popup-feedback.bd-e2e.test', 'https://retained.example/'], 'duplicate rejection keeps both addresses');
    assert.equal((await e.state()).rules.length, 1);
    await fill(block, 'popup-feedback-second.bd-e2e.test'); await fill(redirect, 'ftp://invalid.example');
    await page.evaluate(() => { window.__bdHoldPopupWrite = {}; }); await activate(save);
    await focus(page, '#options-link'); await page.evaluate(() => window.__bdReleasePopupWrite());
    await poll(() => page.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-invalid') === 'true', redirect), Boolean, 'delayed redirect rejection');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'options-link', 'a delayed error respects later focus');
    await fill(redirect, ''); await page.evaluate(() => { window.__bdHoldPopupWrite = {}; }); await activate(save);
    await focus(page, '#options-link'); await page.evaluate(() => window.__bdReleasePopupWrite()); await settled();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'options-link', 'a delayed success respects later focus');
    await poll(async () => (await e.state()).rules.length, count => count === 2, 'second Popup rule committed');

    await add(true);
    assert.equal(await page.evaluate(selector => document.querySelector(selector).disabled, redirect), true);
    await fill(block, 'allowed-independent.bd-e2e.test'); await activate(save); await settled();
    await poll(() => page.evaluate(() => document.activeElement.id), id => id === 'add-whitelist-rule', 'Add Whitelist regains focus');
    const state = await e.state();
    assert.equal(state.rules.length, 3); assert.equal(state.rules.filter(rule => rule.isWhitelist).length, 1);
    assert.equal(await page.evaluate(() => window.__bdPopupWrites.length), 6, 'each Save dispatches once');
  }
}, {
  id: '58',
  title: 'Focus controls retain field errors, guard pending actions and restore safe keyboard focus',
  async run(e) {
    await e.seed({pro:true,rules:[{id:58,blockURL:'focus-controls.bd-e2e.test',redirectURL:'',category:'social',isWhitelist:false,
      assignments:[{listId:'general',disabledByUser:false,blockingMode:'always',schedule:null,dailyLimit:null}]}]});
    const page=await e.openPopup(); if(page.front)await page.front();else await page.bringToFront();
    await poll(()=>page.evaluate(()=>document.body.classList.contains('ready')&&!document.getElementById('focus-duration').disabled),Boolean,'Focus ready');
    assert.deepEqual(await page.evaluate(()=>[document.getElementById('focus-duration-error')?.hidden,
      document.getElementById('focus-timer-display').getAttribute('role'),document.getElementById('focus-timer-display').getAttribute('aria-live'),
      document.getElementById('custom-alert').textContent]),[true,'timer','off','']);
    await page.evaluate(()=>{
      window.__bdFocusWrites=[];window.__bdFocusNotices=[];
      const status=document.getElementById('custom-alert');
      new MutationObserver(()=>{if(status.textContent)window.__bdFocusNotices.push(status.textContent);}).observe(status,{childList:true,characterData:true,subtree:true});
      for(const runtime of new Set([globalThis.chrome?.runtime,globalThis.browser?.runtime].filter(Boolean))){
        const original=runtime.sendMessage.bind(runtime);
        runtime.sendMessage=function(input,...args){
          if(!['start_focus_session','stop_focus_session'].includes(input?.type))return original(input,...args);
          window.__bdFocusWrites.push(structuredClone(input));
          const hold=window.__bdHoldFocus?.type===input.type?window.__bdHoldFocus:null;if(hold)window.__bdHoldFocus=null;
          const gate=hold?new Promise(resolve=>{window.__bdReleaseFocus=resolve;}):Promise.resolve();
          const finish=response=>hold?.pending&&response?.success?{...response,syncPending:true}:response;
          const callback=args.at(-1);
          if(typeof callback==='function'){
            if(!hold)return original(input,...args.slice(0,-1),response=>callback(finish(response)));
            gate.then(()=>original(input,...args.slice(0,-1),response=>callback(finish(response))));return;
          }
          return gate.then(()=>original(input,...args)).then(finish);
        };
      }
    });
    const fill=value=>page.locator?page.locator('#focus-duration').fill(value):page.fill('#focus-duration',value);
    const activate=async selector=>{await focus(page,selector);await press(page,'Enter');};
    await fill('1.5');await activate('#start-focus-btn');
    await poll(()=>page.evaluate(()=>document.activeElement.id==='focus-duration'&&document.activeElement.getAttribute('aria-invalid')==='true'),Boolean,'duration error focus');
    assert.deepEqual(await page.evaluate(()=>[document.activeElement.value,document.activeElement.getAttribute('aria-describedby'),window.__bdFocusWrites.length,
      document.getElementById('custom-alert').textContent]),['1.5','focus-duration-error',0,'']);
    await fill('25');assert.equal(await page.evaluate(()=>document.getElementById('focus-duration').getAttribute('aria-invalid')),null);
    await page.evaluate(()=>{window.__bdHoldFocus={type:'start_focus_session'};});
    await activate('#start-focus-btn');await press(page,'Enter');
    assert.deepEqual(await page.evaluate(()=>[window.__bdFocusWrites.length,document.activeElement.id,document.activeElement.getAttribute('aria-disabled'),
      document.getElementById('focus-controls').getAttribute('aria-busy'),document.getElementById('focus-duration').disabled]),[1,'start-focus-btn','true','true',true]);
    await page.evaluate(()=>window.__bdReleaseFocus());
    await poll(async()=>(await e.state()).focusSession.focusActive,Boolean,'native Focus start');
    await poll(()=>page.evaluate(()=>document.activeElement.id==='stop-focus-btn'&&!document.activeElement.hasAttribute('aria-disabled')),Boolean,'available Stop focus');
    await poll(()=>page.evaluate(()=>window.__bdFocusNotices.length),n=>n===1,'one start notice');
    const time=await page.evaluate(()=>document.getElementById('focus-timer-display').textContent);
    await poll(()=>page.evaluate(()=>document.getElementById('focus-timer-display').textContent),value=>value!==time,'native timer tick');
    assert.equal(await page.evaluate(()=>window.__bdFocusNotices.length),1,'ticks do not add live notices');
    await page.evaluate(()=>{window.__bdHoldFocus={type:'stop_focus_session',pending:true};});
    await activate('#stop-focus-btn');await press(page,'Enter');assert.equal(await page.evaluate(()=>window.__bdFocusWrites.length),2);
    await focus(page,'#options-link');await page.evaluate(()=>window.__bdReleaseFocus());
    await poll(async()=>(await e.state()).focusSession.focusActive,value=>value===false,'native Stop commit');
    await poll(()=>page.evaluate(()=>document.getElementById('focus-active-view').hidden),Boolean,'inactive view');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'options-link');
    await poll(()=>page.evaluate(()=>document.getElementById('custom-alert').textContent),text=>text.length>0&&text!=='', 'status available');
    const pending=await page.evaluate(()=>(globalThis.browser||chrome).i18n.getMessage('ruleschangessavedpending'));
    await poll(()=>page.evaluate(()=>document.getElementById('custom-alert').textContent),text=>text===pending,'saved pending Stop');
    assert.equal(await page.evaluate(()=>window.__bdFocusWrites.length),2);
    await focus(page,'#focus-hardcore-mode');await press(page,'Space');await activate('#start-focus-btn');
    await poll(()=>page.evaluate(()=>document.activeElement.id==='focus-active-label'&&document.getElementById('stop-focus-btn').hidden),Boolean,'Hardcore static focus');
    assert.deepEqual(await page.evaluate(()=>[document.activeElement.getAttribute('aria-describedby'),document.getElementById('focus-hardcore-description').hidden]),['focus-hardcore-description',false]);
    const name=await page.evaluate(()=>(globalThis.browser||chrome).i18n.getMessage('focussessionactivebanner'));
    if(page.getByRole)assert.equal(await page.getByRole('timer',{name,exact:true}).count(),1);
    else{assert.equal(await(await page.element('#focus-timer-display')).getAriaRole(),'timer');await poll(async()=>(await page.element('#focus-timer-display')).getAccessibleName(),value=>value===name,'computed timer name');}
    // Only this isolated stored deadline is shortened: native UI expiry, not an alarms or OS-resume test.
    const state=(await e.state()).focusSession;await e.writeLocal({focusSession:{...state,focusEndTime:Date.now()+250}});
    await poll(()=>page.evaluate(()=>document.activeElement.id==='start-focus-btn'&&document.getElementById('focus-active-view').hidden),Boolean,'observed completion focus');
    await poll(()=>page.evaluate(()=>window.__bdFocusNotices.filter(text=>text===(globalThis.browser||chrome).i18n.getMessage('focussessionended')).length),n=>n===1,'one completion notice');
    assert.equal(await page.evaluate(()=>window.__bdFocusWrites.length),3,'no duplicate requests or implicit expiry Stop');
  }
}
,{
  id: '59',
  title: 'Rule deletion retains keyboard focus, supports Strict cancellation and guards pending native mutations',
  async run(e) {
    const rule = (id, whitelist = false) => ({ id, blockURL: `delete-${id}.bd-e2e.test`, redirectURL: '',
      category: whitelist ? 'whitelist' : 'social', isWhitelist: whitelist,
      assignments: [{ listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null }] });
    await e.seed({ pro: true, rules: [rule(591), rule(592), rule(593), rule(594, true)] });
    const setup = page => page.evaluate(() => {
      window.__bdDeleteWrites = []; window.__bdDeleteEvents = [];
      for (const type of ['focusin', 'keydown', 'click']) document.addEventListener(type, event => {
        __bdDeleteEvents.push([type, event.key || '', event.target.className, event.target.id, event.target.parentNode?.dataset.ruleId]);
      }, true);
      for (const runtime of new Set([globalThis.chrome?.runtime, globalThis.browser?.runtime].filter(Boolean))) {
        const original = runtime.sendMessage.bind(runtime);
        runtime.sendMessage = function(input, ...args) {
          if (!['rules:delete', 'rules:removeAssignment'].includes(input?.type)) return original(input, ...args);
          window.__bdDeleteWrites.push(structuredClone(input));
          const hold = window.__bdHoldDelete; window.__bdHoldDelete = false;
          const gate = hold ? new Promise(resolve => { window.__bdReleaseDelete = resolve; }) : Promise.resolve();
          // A controlled failed reply exercises UI retry; successful requests reach the real worker.
          const reject = window.__bdRejectDelete; window.__bdRejectDelete = false;
          const callback = args.at(-1);
          if (typeof callback === 'function') {
            gate.then(() => reject ? callback({ success: false, error: { code: 'rules_operation_failed' } }) : original(input, ...args));
            return;
          }
          return gate.then(() => reject ? { success: false, error: { code: 'rules_operation_failed' } } : original(input, ...args));
        };
      }
    });
    const mode = (page, value) => page.evaluate(async value => {
      const api = globalThis.browser || chrome, { settings } = await api.storage.sync.get('settings');
      await api.storage.sync.set({ settings: { ...settings, mode: value } });
    }, value);
    const selector = id => `[data-rule-id="${id}"] .delete-btn`;
    const activate = async (page, target) => {
      if (page.harness?.driver) await page.harness.driver.switchTo().window(page.context);
      else await page.bringToFront();
      if (page.settleOptions) await page.settleOptions();
      const proof = await page.evaluate(target => { const before = document.hasFocus(); const node = document.querySelector(target);
        node.focus(); return { before, after: document.hasFocus(), hidden: document.hidden, same: document.activeElement === node, active: document.activeElement.outerHTML }; }, target);
      assert.equal(proof.same, true, `native focus ${target}: ${JSON.stringify(proof)}`);
      await press(page, 'Enter');
    };
    const ready = async page => {
      if (page.front) await page.front(); else await page.bringToFront();
      await poll(() => page.evaluate(() => !!document.querySelector('[data-rule-id="591"] .delete-btn')), Boolean, 'saved deletion controls');
      await setup(page);
    };
    const page = await e.openOptions(); await ready(page); await mode(page, 'strict');
    const expectedName = await page.evaluate(() => `${(globalThis.browser || chrome).i18n.getMessage('deletebtn')}: delete-592.bd-e2e.test`);
    await activate(page, selector(592));
    await poll(() => page.evaluate(() => !!document.querySelector('.rule-deletion-row .delete-cancel')), Boolean, 'Strict cancel control');
    const waiting = await page.evaluate(() => {
      const row = document.querySelector('[data-rule-id="592"]'), button = row.querySelector('.delete-btn');
      return [button.disabled, button.getAttribute('aria-disabled'), button.getAttribute('aria-label'),
        document.querySelector('.rule-deletion-row [role="timer"]')?.getAttribute('aria-live'), document.activeElement === button];
    });
    assert.deepEqual(waiting, [false, 'true', expectedName, 'off', true]);
    if (page.getByRole) assert.equal(await page.getByRole('button', { name: expectedName, exact: true }).count(), 1);
    else assert.equal(await (await page.element(selector(592))).getAccessibleName(), expectedName);
    await press(page, 'Enter'); assert.equal(await page.evaluate(() => __bdDeleteWrites.length), 0);
    await press(page, 'Escape');
    await poll(() => page.evaluate(() => !document.querySelector('.delete-cancel')), Boolean, 'Escape cancellation');
    assert.equal((await e.state()).rules.length, 4);
    await activate(page, selector(592)); await press(page, 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('delete-cancel')), true);
    await press(page, 'Enter');
    assert.equal(await page.evaluate(() => document.activeElement.matches('[data-rule-id="592"] .delete-btn')), true);
    await page.evaluate(() => { window.__bdDeleteStarted = performance.now(); });
    await activate(page, selector(592));
    await poll(() => page.evaluate(() => !!document.querySelector('[data-rule-id="592"] .delete-ready')), Boolean, 'ten-second Strict countdown');
    assert.ok(await page.evaluate(() => performance.now() - __bdDeleteStarted) >= 9900, 'the real countdown is not shortened');
    await new Promise(resolve => setTimeout(resolve, 5200));
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('delete-ready')), true, 'focused confirmation survives inactivity timeout');
    await page.evaluate(() => { window.__bdHoldDelete = true; });
    await press(page, 'Enter'); await press(page, 'Enter');
    await poll(() => page.evaluate(() => __bdDeleteWrites.length), count => count === 1, 'one pending deletion');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-busy')), 'true');
    await page.evaluate(() => __bdReleaseDelete());
    await poll(async () => (await e.state()).rules.some(rule => rule.id === 592), present => !present, 'native assignment deletion');
    await poll(() => page.evaluate(() => document.activeElement.matches('[data-rule-id="591"] .delete-btn')), Boolean, 'next visible rule focus');

    const popup = await e.openPopup(); await ready(popup); await mode(popup, 'normal');
    await popup.evaluate(() => { window.__bdRejectDelete = true; });
    await activate(popup, selector(593));
    await poll(() => popup.evaluate(() => __bdDeleteWrites.length === 1 && !!document.querySelector('[data-rule-id="593"] .delete-btn:not([aria-disabled="true"])')), Boolean, 'failed deletion remains retryable');
    assert.equal((await e.state()).rules.some(rule => rule.id === 593), true);
    await popup.evaluate(() => { window.__bdHoldDelete = true; });
    await activate(popup, selector(593)); await press(popup, 'Enter');
    assert.equal(await popup.evaluate(() => __bdDeleteWrites.length), 2, 'retry issues one request');
    await focus(popup, '#options-link'); await popup.evaluate(() => __bdReleaseDelete());
    await poll(async () => (await e.state()).rules.some(rule => rule.id === 593), present => !present, 'native Popup assignment deletion');
    await poll(() => popup.evaluate(() => !document.querySelector('[data-rule-id="593"]')), Boolean, 'Popup refresh');
    assert.equal(await popup.evaluate(() => document.activeElement.id), 'options-link', 'later focus choice wins');
    // Continue with native Tab from the user's later focus choice. Reacquire
    // via keyboard instead of relying on a new script focus in this state.
    for (let step = 0; step < 30 && !await popup.evaluate(() => document.activeElement.matches('[data-rule-id="594"] .delete-btn')); step++) await press(popup, 'Tab');
    assert.equal(await popup.evaluate(() => document.activeElement.matches('[data-rule-id="594"] .delete-btn')), true, 'Tab reaches whitelist deletion');
    await press(popup, 'Enter');
    await poll(() => popup.evaluate(() => ({ writes: __bdDeleteWrites,
      active: document.activeElement.outerHTML, events: __bdDeleteEvents.slice(-15), buttons: [...document.querySelectorAll('.delete-btn')].map(button => [button.parentNode.dataset.ruleId, button.getAttribute('aria-disabled'), button.className]) })),
      value => value.writes.length === 3, 'whitelist intent dispatch');
    await poll(async () => (await e.state()).rules.some(rule => rule.id === 594), present => !present, 'native whitelist deletion');
    await poll(() => popup.evaluate(() => document.activeElement.matches('[data-rule-id="591"] .delete-btn')), Boolean, 'whitelist deletion focus');
    await press(popup, 'Enter');
    await poll(async () => (await e.state()).rules.length, count => count === 0, 'last native rule deletion');
    await poll(() => popup.evaluate(() => document.activeElement.id), id => id === 'add-rule', 'empty Popup Add focus');
    const writes = await popup.evaluate(() => __bdDeleteWrites.map(message => [message.type, message.payload.ruleId]));
    assert.deepEqual(writes, [['rules:removeAssignment', 593], ['rules:removeAssignment', 593], ['rules:delete', 594], ['rules:removeAssignment', 591]]);
  }
}, ...statisticsScenarios
];
